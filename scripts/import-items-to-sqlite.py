#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlite_migration_lib import ITEM_TYPE_MAP, PROTECTED_ITEMS, connect_sqlite, next_id, normalize_header, parse_int, read_csv_rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import or update item settings in a SQLite finance database from CSV.")
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--items-csv", required=True, help="Items CSV path.")
    parser.add_argument("--user-id", default="", help="Optional user id override. Defaults to the first user in the database.")
    return parser.parse_args()


def read_user_id(conn, user_id: str) -> str:
    if user_id:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise SystemExit(f"找不到指定 user id：{user_id}")
        return str(row["id"])

    row = conn.execute("SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1").fetchone()
    if not row:
        raise SystemExit("資料庫內沒有 users 資料。")
    return str(row["id"])


def has_column(conn, table: str, column_name: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(str(row["name"] or "") == column_name for row in rows)


def load_existing_names(conn, user_id: str) -> dict[str, tuple[str, str, str]]:
    rows = conn.execute(
        """
        SELECT 'accounts' AS collection, id, name, type FROM accounts WHERE user_id = ?
        UNION ALL
        SELECT 'categories' AS collection, id, name, type FROM categories WHERE user_id = ?
        """,
        (user_id, user_id),
    ).fetchall()
    return {normalize_header(row["name"]): (str(row["collection"]), str(row["id"]), str(row["type"])) for row in rows}


def load_earliest_transaction_months(conn, user_id: str) -> tuple[str, dict[str, str]]:
    global_row = conn.execute(
        """
        SELECT substr(MIN(txn_date), 1, 7) AS month
        FROM transactions
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchone()
    account_rows = conn.execute(
        """
        SELECT account_id, MIN(month) AS month
        FROM (
          SELECT from_id AS account_id, substr(txn_date, 1, 7) AS month
          FROM transactions
          WHERE user_id = ? AND from_kind = 'account'
          UNION ALL
          SELECT to_id AS account_id, substr(txn_date, 1, 7) AS month
          FROM transactions
          WHERE user_id = ? AND to_kind = 'account'
        )
        GROUP BY account_id
        """,
        (user_id, user_id),
    ).fetchall()
    return (
        str((global_row["month"] or "") if global_row else ""),
        {str(row["account_id"]): str(row["month"] or "") for row in account_rows},
    )


def earlier_month(first_month: str, second_month: str) -> str:
    candidates = [str(first_month or "").strip(), str(second_month or "").strip()]
    valid = [month for month in candidates if len(month) == 7 and month[4] == "-"]
    return min(valid) if valid else ""


def parse_summaries(text: str) -> list[str]:
    summaries: list[str] = []
    for piece in str(text or "").replace("；", ";").split(";"):
        normalized = piece.strip()
        if normalized and normalized not in summaries:
            summaries.append(normalized)
    return summaries[:6]


def next_order(conn, user_id: str, table: str, item_type: str) -> int:
    row = conn.execute(
        f"SELECT MAX(order_index) AS max_order FROM {table} WHERE user_id = ? AND type = ?",
        (user_id, item_type),
    ).fetchone()
    max_order = int((row["max_order"] or 0) if row else 0)
    return max(100, max_order + 10)


def replace_common_summaries(conn, user_id: str, category_id: str, summaries: list[str]) -> None:
    scope_key = f"category:{category_id}"
    conn.execute("DELETE FROM common_summaries WHERE user_id = ? AND scope_key = ?", (user_id, scope_key))
    if summaries:
        conn.executemany(
            """
            INSERT INTO common_summaries (user_id, scope_key, order_index, summary)
            VALUES (?, ?, ?, ?)
            """,
            [(user_id, scope_key, index, summary) for index, summary in enumerate(summaries)],
        )


def save_snapshot_dirty_month(conn, user_id: str, dirty_month: str) -> None:
    if not dirty_month:
        return
    row = conn.execute(
        "SELECT snapshot_dirty_from_month FROM user_settings WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    current = str((row["snapshot_dirty_from_month"] or "") if row else "")
    next_month = earlier_month(current, dirty_month) or dirty_month
    if row:
        conn.execute(
            """
            UPDATE user_settings
            SET snapshot_dirty_from_month = ?, updated_at = unixepoch()
            WHERE user_id = ?
            """,
            (next_month, user_id),
        )
        return
    conn.execute(
        """
        INSERT INTO user_settings (
          user_id, monthly_budget, recurring_applied_month, snapshot_dirty_from_month, legacy_transactions_checked_at
        ) VALUES (?, 0, '', ?, 0)
        """,
        (user_id, next_month),
    )


def import_items(conn, user_id: str, rows: list[dict[str, str]]) -> tuple[int, int, int, str]:
    existing_names = load_existing_names(conn, user_id)
    earliest_transaction_month, earliest_account_months = load_earliest_transaction_months(conn, user_id)
    account_has_currency = has_column(conn, "accounts", "currency")
    created_count = 0
    updated_count = 0
    skipped_count = 0
    dirty_month = ""

    for index, row in enumerate(rows, start=2):
        label = normalize_header(row.get("類別", ""))
        name = normalize_header(row.get("項目名稱", ""))
        if not label or not name:
            skipped_count += 1
            continue
        if label not in ITEM_TYPE_MAP:
            raise ValueError(f"第 {index} 列類別無法辨識：{label}")

        item_type = ITEM_TYPE_MAP[label]
        table = "accounts" if item_type in {"asset", "liability"} else "categories"
        existing = existing_names.get(name)
        if existing and (existing[0] != table or existing[2] != item_type):
            raise ValueError(f"第 {index} 列項目名稱和既有其他類型衝突：{name}")

        raw_order = str(row.get("次序", "") or "").strip()
        order_index = parse_int(raw_order, f"第 {index} 列的次序", allow_blank=True, default=next_order(conn, user_id, table, item_type))

        if table == "accounts":
            opening_balance = parse_int(row.get("期初餘額", ""), f"第 {index} 列的期初餘額", allow_blank=True, default=0)
            currency = normalize_header(row.get("幣別", "")).upper() or "TWD"
            is_protected = int(("accounts", item_type, name) in PROTECTED_ITEMS)
            if existing:
                item_id = existing[1]
                current_row = conn.execute(
                    "SELECT opening_balance FROM accounts WHERE user_id = ? AND id = ?",
                    (user_id, item_id),
                ).fetchone()
                current_balance = int((current_row["opening_balance"] or 0) if current_row else 0)
                if current_balance != opening_balance:
                    dirty_month = earlier_month(
                        dirty_month,
                        earliest_account_months.get(item_id, "") or earliest_transaction_month,
                    )
                if account_has_currency:
                    conn.execute(
                        """
                        UPDATE accounts
                        SET name = ?, type = ?, currency = ?, opening_balance = ?, order_index = ?, is_protected = ?, updated_at = unixepoch()
                        WHERE user_id = ? AND id = ?
                        """,
                        (name, item_type, currency, opening_balance, order_index, is_protected, user_id, item_id),
                    )
                else:
                    conn.execute(
                        """
                        UPDATE accounts
                        SET name = ?, type = ?, opening_balance = ?, order_index = ?, is_protected = ?, updated_at = unixepoch()
                        WHERE user_id = ? AND id = ?
                        """,
                        (name, item_type, opening_balance, order_index, is_protected, user_id, item_id),
                    )
                updated_count += 1
            else:
                item_id = next_id("acc")
                if account_has_currency:
                    conn.execute(
                        """
                        INSERT INTO accounts (id, user_id, name, type, currency, opening_balance, order_index, is_protected)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (item_id, user_id, name, item_type, currency, opening_balance, order_index, is_protected),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO accounts (id, user_id, name, type, opening_balance, order_index, is_protected)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (item_id, user_id, name, item_type, opening_balance, order_index, is_protected),
                    )
                created_count += 1
            existing_names[name] = ("accounts", item_id, item_type)
            continue

        is_protected = int(("categories", item_type, name) in PROTECTED_ITEMS)
        summaries = parse_summaries(row.get("常用摘要", ""))
        if existing:
            item_id = existing[1]
            conn.execute(
                """
                UPDATE categories
                SET name = ?, type = ?, order_index = ?, is_protected = ?, updated_at = unixepoch()
                WHERE user_id = ? AND id = ?
                """,
                (name, item_type, order_index, is_protected, user_id, item_id),
            )
            updated_count += 1
        else:
            item_id = next_id("cat")
            conn.execute(
                """
                INSERT INTO categories (id, user_id, name, type, order_index, is_protected)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (item_id, user_id, name, item_type, order_index, is_protected),
            )
            created_count += 1
        replace_common_summaries(conn, user_id, item_id, summaries)
        existing_names[name] = ("categories", item_id, item_type)

    save_snapshot_dirty_month(conn, user_id, dirty_month)
    return created_count, updated_count, skipped_count, dirty_month


def main() -> int:
    args = parse_args()
    db_path = Path(args.db).expanduser().resolve()
    items_path = Path(args.items_csv).expanduser().resolve()

    if not items_path.exists():
        raise FileNotFoundError(f"找不到 items CSV：{items_path}")

    rows = read_csv_rows(items_path)
    conn = connect_sqlite(db_path)
    try:
        user_id = read_user_id(conn, args.user_id)
        try:
            created_count, updated_count, skipped_count, dirty_month = import_items(conn, user_id, rows)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()

    print(f"Items imported into: {db_path}")
    print(f"Created: {created_count}")
    print(f"Updated: {updated_count}")
    print(f"Skipped: {skipped_count}")
    if dirty_month:
        print(f"Snapshot dirty from month: {dirty_month}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
