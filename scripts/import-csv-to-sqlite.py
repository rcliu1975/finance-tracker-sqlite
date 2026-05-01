#!/usr/bin/env python3
"""
Build a SQLite database from the existing item / transaction CSV exports.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
import sqlite3

from sqlite_migration_lib import (
    ITEM_TYPE_MAP,
    PROTECTED_ITEMS,
    ItemRef,
    has_column,
    load_schema,
    next_id,
    normalize_date,
    normalize_header,
    parse_int,
    prepare_database,
    read_csv_rows,
    repo_root_from_script,
)


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

def import_items(connection: sqlite3.Connection, rows: list[dict[str, str]], user_id: str) -> dict[str, ItemRef]:
    item_refs: dict[str, ItemRef] = {}
    common_summary_rows: list[tuple[str, str, int, str]] = []
    account_has_currency = has_column(connection, "accounts", "currency")

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
            currency = normalize_header(row.get("幣別", "")).upper() or "TWD"
            opening_balance = parse_int(row.get("期初餘額", ""), f"第 {index} 列的期初餘額", allow_blank=True, default=0)
            is_protected = int(("accounts", item_type, name) in PROTECTED_ITEMS)
            if account_has_currency:
                connection.execute(
                    """
                    INSERT INTO accounts (id, user_id, name, type, currency, opening_balance, order_index, is_protected)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (item_id, user_id, name, item_type, currency, opening_balance, order_index, is_protected),
                )
            else:
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
    transaction_has_dual_amount = has_column(connection, "transactions", "from_amount") and has_column(connection, "transactions", "to_amount")
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

        legacy_amount = str(row.get("金額", "") or "").strip()
        from_amount_text = str(row.get("從金額", "") or "").strip()
        to_amount_text = str(row.get("至金額", "") or "").strip()
        if legacy_amount:
            amount = parse_int(legacy_amount, f"第 {index} 列的金額")
        else:
            from_amount = parse_int(from_amount_text, f"第 {index} 列的從金額")
            to_amount = parse_int(to_amount_text, f"第 {index} 列的至金額")
            if from_amount != to_amount:
                raise ValueError(
                    f"第 {index} 列的從金額 ({from_amount}) 與至金額 ({to_amount}) 不同；目前 SQLite schema 尚未切到雙金額欄位。"
                )
            amount = from_amount

        if transaction_has_dual_amount:
            final_from_amount = parse_int(from_amount_text or legacy_amount, f"第 {index} 列的從金額")
            final_to_amount = parse_int(to_amount_text or legacy_amount, f"第 {index} 列的至金額")
            connection.execute(
                """
                INSERT INTO transactions (
                  id, user_id, txn_date, from_kind, from_id, to_kind, to_id, from_amount, to_amount, note, memo
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    next_id("txn"),
                    user_id,
                    normalize_date(row.get("日期", "")),
                    transaction_kind(from_ref.collection),
                    from_ref.item_id,
                    transaction_kind(to_ref.collection),
                    to_ref.item_id,
                    final_from_amount,
                    final_to_amount,
                    str(row.get("摘要", "") or "").strip(),
                    str(row.get("備註", "") or "").strip(),
                ),
            )
        else:
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
                    amount,
                    str(row.get("摘要", "") or "").strip(),
                    str(row.get("備註", "") or "").strip(),
                ),
            )
        inserted += 1
    return inserted


def main() -> int:
    args = parse_args()
    repo_root = repo_root_from_script(__file__)
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
