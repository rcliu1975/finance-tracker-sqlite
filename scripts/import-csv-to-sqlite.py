#!/usr/bin/env python3
"""
Build a SQLite database from the existing item / transaction CSV exports.
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path


ITEM_TYPE_MAP = {
    "資產": "asset",
    "負債": "liability",
    "收入": "income",
    "支出": "expense",
    "業外收入": "nonOperatingIncome",
    "業外支出": "nonOperatingExpense",
}

PROTECTED_ITEMS = {
    ("accounts", "asset", "現金"),
    ("accounts", "liability", "應付帳款"),
    ("categories", "income", "薪資收入"),
    ("categories", "expense", "餐飲費"),
}


@dataclass
class ItemRef:
    collection: str
    item_type: str
    item_id: str
    name: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import current finance CSV exports into SQLite.")
    parser.add_argument("--db", required=True, help="Target SQLite database path.")
    parser.add_argument("--items-csv", required=True, help="Items CSV path.")
    parser.add_argument("--transactions-csv", required=True, help="Transactions CSV path.")
    parser.add_argument("--user-id", default="local-user", help="Logical user id stored in SQLite.")
    parser.add_argument("--user-email", default="", help="Optional user email stored in SQLite.")
    parser.add_argument("--display-name", default="Local User", help="Optional display name stored in SQLite.")
    parser.add_argument("--replace", action="store_true", help="Replace the target database if it already exists.")
    return parser.parse_args()


def load_schema(schema_path: Path) -> str:
    return schema_path.read_text(encoding="utf-8")


def normalize_header(value: str) -> str:
    return str(value or "").strip()


def parse_int(value: str, field_name: str, *, allow_blank: bool = False, default: int = 0) -> int:
    text = str(value or "").strip()
    if not text:
        if allow_blank:
            return default
        raise ValueError(f"{field_name} 不可空白")
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(f"{field_name} 不是有效數字：{text}") from exc
    if number != number.to_integral_value():
        raise ValueError(f"{field_name} 必須是整數：{text}")
    return int(number)


def normalize_date(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        raise ValueError("日期不可空白")
    raw = raw.replace("-", "/")
    parts = raw.split("/")
    if len(parts) != 3:
        raise ValueError(f"無法解析日期：{raw}")
    year, month, day = parts
    if len(year) != 4:
        raise ValueError(f"年份格式錯誤：{raw}")
    return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"


def next_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [{normalize_header(key): (value or "") for key, value in row.items()} for row in reader]


def prepare_database(db_path: Path, schema_sql: str, replace: bool) -> sqlite3.Connection:
    if db_path.exists():
        if not replace:
            raise FileExistsError(f"資料庫已存在：{db_path}")
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(schema_sql)
    return connection


def import_items(connection: sqlite3.Connection, rows: list[dict[str, str]], user_id: str) -> dict[str, ItemRef]:
    item_refs: dict[str, ItemRef] = {}
    common_summary_rows: list[tuple[str, str, int, str]] = []

    for index, row in enumerate(rows, start=2):
        label = normalize_header(row.get("類別", ""))
        name = normalize_header(row.get("項目名稱", ""))
        order_index = parse_int(row.get("次序", ""), f"第 {index} 列的次序", allow_blank=True, default=0)
        summary_text = str(row.get("常用摘要", "") or "").strip()

        if not label or not name:
            raise ValueError(f"第 {index} 列缺少 類別 或 項目名稱")
        if name in item_refs:
            raise ValueError(f"第 {index} 列項目名稱重複：{name}")
        if label not in ITEM_TYPE_MAP:
            raise ValueError(f"第 {index} 列類別無法辨識：{label}")

        item_type = ITEM_TYPE_MAP[label]
        if item_type in {"asset", "liability"}:
            item_id = next_id("acc")
            opening_balance = parse_int(row.get("期初餘額", ""), f"第 {index} 列的期初餘額", allow_blank=True, default=0)
            is_protected = int(("accounts", item_type, name) in PROTECTED_ITEMS)
            connection.execute(
                """
                INSERT INTO accounts (id, user_id, name, type, opening_balance, order_index, is_protected)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (item_id, user_id, name, item_type, opening_balance, order_index, is_protected),
            )
            item_refs[name] = ItemRef("accounts", item_type, item_id, name)
            continue

        item_id = next_id("cat")
        is_protected = int(("categories", item_type, name) in PROTECTED_ITEMS)
        connection.execute(
            """
            INSERT INTO categories (id, user_id, name, type, order_index, is_protected)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (item_id, user_id, name, item_type, order_index, is_protected),
        )
        item_refs[name] = ItemRef("categories", item_type, item_id, name)

        if summary_text:
            summaries = []
            for piece in summary_text.replace("；", ";").split(";"):
                normalized = piece.strip()
                if normalized and normalized not in summaries:
                    summaries.append(normalized)
            for summary_index, summary in enumerate(summaries[:6]):
                common_summary_rows.append((user_id, f"category:{item_id}", summary_index, summary))

    if common_summary_rows:
        connection.executemany(
            """
            INSERT INTO common_summaries (user_id, scope_key, order_index, summary)
            VALUES (?, ?, ?, ?)
            """,
            common_summary_rows,
        )

    return item_refs


def transaction_kind(collection: str) -> str:
    return "account" if collection == "accounts" else "category"


def import_transactions(
    connection: sqlite3.Connection,
    rows: list[dict[str, str]],
    user_id: str,
    item_refs: dict[str, ItemRef],
) -> int:
    inserted = 0
    for index, row in enumerate(rows, start=2):
        from_name = normalize_header(row.get("從項目", ""))
        to_name = normalize_header(row.get("至項目", ""))
        if not from_name or not to_name:
            raise ValueError(f"第 {index} 列缺少 從項目 或 至項目")

        from_ref = item_refs.get(from_name)
        to_ref = item_refs.get(to_name)
        if not from_ref:
            raise ValueError(f"第 {index} 列找不到從項目：{from_name}")
        if not to_ref:
            raise ValueError(f"第 {index} 列找不到至項目：{to_name}")

        connection.execute(
            """
            INSERT INTO transactions (
              id, user_id, txn_date, from_kind, from_id, to_kind, to_id, amount, note, memo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                next_id("txn"),
                user_id,
                normalize_date(row.get("日期", "")),
                transaction_kind(from_ref.collection),
                from_ref.item_id,
                transaction_kind(to_ref.collection),
                to_ref.item_id,
                parse_int(row.get("金額", ""), f"第 {index} 列的金額"),
                str(row.get("摘要", "") or "").strip(),
                str(row.get("備註", "") or "").strip(),
            ),
        )
        inserted += 1
    return inserted


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parent.parent
    schema_path = repo_root / "sqlite" / "schema.sql"
    schema_sql = load_schema(schema_path)

    db_path = Path(args.db).expanduser().resolve()
    items_path = Path(args.items_csv).expanduser().resolve()
    transactions_path = Path(args.transactions_csv).expanduser().resolve()

    if not items_path.exists():
        raise FileNotFoundError(f"找不到 items CSV：{items_path}")
    if not transactions_path.exists():
        raise FileNotFoundError(f"找不到 transactions CSV：{transactions_path}")

    item_rows = read_csv_rows(items_path)
    transaction_rows = read_csv_rows(transactions_path)

    connection = prepare_database(db_path, schema_sql, args.replace)
    try:
        connection.execute(
            "INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)",
            (args.user_id, args.user_email.strip(), args.display_name.strip()),
        )
        connection.execute(
            """
            INSERT INTO user_settings (
              user_id, monthly_budget, recurring_applied_month, snapshot_dirty_from_month, legacy_transactions_checked_at
            ) VALUES (?, 0, '', '', 0)
            """,
            (args.user_id,),
        )
        item_refs = import_items(connection, item_rows, args.user_id)
        transaction_count = import_transactions(connection, transaction_rows, args.user_id, item_refs)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    print(f"SQLite database created: {db_path}")
    print(f"Items imported: {len(item_refs)}")
    print(f"Transactions imported: {transaction_count}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
