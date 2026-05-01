#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from sqlite_migration_lib import connect_sqlite


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export transaction records from a SQLite finance database to CSV.")
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--output", required=True, help="Output CSV file path.")
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


def load_item_name_maps(conn, user_id: str) -> tuple[dict[str, str], dict[str, str]]:
    account_rows = conn.execute("SELECT id, name FROM accounts WHERE user_id = ?", (user_id,)).fetchall()
    category_rows = conn.execute("SELECT id, name FROM categories WHERE user_id = ?", (user_id,)).fetchall()
    return (
        {str(row["id"]): str(row["name"] or "") for row in account_rows},
        {str(row["id"]): str(row["name"] or "") for row in category_rows},
    )


def resolve_item_name(kind: str, item_id: str, account_names: dict[str, str], category_names: dict[str, str]) -> str:
    if kind == "account":
        return account_names.get(item_id, "")
    if kind == "category":
        return category_names.get(item_id, "")
    return ""


def export_rows(conn, user_id: str) -> list[list[str]]:
    account_names, category_names = load_item_name_maps(conn, user_id)
    transaction_rows = conn.execute(
        """
        SELECT txn_date, from_kind, from_id, to_kind, to_id, amount, note, memo, created_at, id
        FROM transactions
        WHERE user_id = ?
        ORDER BY txn_date ASC, created_at ASC, id ASC
        """,
        (user_id,),
    ).fetchall()

    rows: list[list[str]] = [["日期", "從項目", "從金額", "至項目", "至金額", "摘要", "備註"]]
    for row in transaction_rows:
        from_id = str(row["from_id"] or "")
        to_id = str(row["to_id"] or "")
        amount = str(int(row["amount"] or 0))
        rows.append(
            [
                str(row["txn_date"] or ""),
                resolve_item_name(str(row["from_kind"] or ""), from_id, account_names, category_names),
                amount,
                resolve_item_name(str(row["to_kind"] or ""), to_id, account_names, category_names),
                amount,
                str(row["note"] or ""),
                str(row["memo"] or ""),
            ]
        )
    return rows


def main() -> None:
    args = parse_args()
    db_path = Path(args.db).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    conn = connect_sqlite(db_path)
    try:
        user_id = read_user_id(conn, args.user_id)
        rows = export_rows(conn, user_id)
    finally:
        conn.close()

    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(rows)
    print(f"已匯出 {output_path}")


if __name__ == "__main__":
    main()
