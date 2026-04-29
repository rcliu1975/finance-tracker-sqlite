#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from sqlite_migration_lib import connect_sqlite


TYPE_LABELS = {
    "asset": "資產",
    "liability": "負債",
    "income": "收入",
    "expense": "支出",
    "nonOperatingIncome": "業外收入",
    "nonOperatingExpense": "業外支出",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export item settings from a SQLite finance database to CSV.")
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


def load_common_summaries(conn, user_id: str) -> dict[str, str]:
    rows = conn.execute(
        """
        SELECT scope_key, summary
        FROM common_summaries
        WHERE user_id = ?
        ORDER BY scope_key ASC, order_index ASC
        """,
        (user_id,),
    ).fetchall()
    grouped: dict[str, list[str]] = {}
    for row in rows:
        scope_key = str(row["scope_key"] or "")
        grouped.setdefault(scope_key, []).append(str(row["summary"] or ""))
    return {key: "；".join(values[:6]) for key, values in grouped.items()}


def export_rows(conn, user_id: str) -> list[list[str]]:
    summaries_by_scope = load_common_summaries(conn, user_id)
    rows: list[list[str]] = [["類別", "項目名稱", "期初餘額", "次序", "保護項目", "ID", "常用摘要"]]

    account_rows = conn.execute(
        """
        SELECT id, name, type, opening_balance, order_index, is_protected, created_at
        FROM accounts
        WHERE user_id = ?
        ORDER BY
          CASE type WHEN 'asset' THEN 0 WHEN 'liability' THEN 1 ELSE 99 END,
          order_index ASC,
          created_at ASC,
          id ASC
        """,
        (user_id,),
    ).fetchall()
    for row in account_rows:
        rows.append(
            [
                TYPE_LABELS[str(row["type"] or "")],
                str(row["name"] or ""),
                str(int(row["opening_balance"] or 0)),
                str(int(row["order_index"] or 0)),
                "是" if int(row["is_protected"] or 0) else "否",
                str(row["id"] or ""),
                "",
            ]
        )

    category_rows = conn.execute(
        """
        SELECT id, name, type, order_index, is_protected, created_at
        FROM categories
        WHERE user_id = ?
        ORDER BY
          CASE type
            WHEN 'income' THEN 2
            WHEN 'expense' THEN 3
            WHEN 'nonOperatingIncome' THEN 4
            WHEN 'nonOperatingExpense' THEN 5
            ELSE 99
          END,
          order_index ASC,
          created_at ASC,
          id ASC
        """,
        (user_id,),
    ).fetchall()
    for row in category_rows:
        item_id = str(row["id"] or "")
        rows.append(
            [
                TYPE_LABELS[str(row["type"] or "")],
                str(row["name"] or ""),
                "",
                str(int(row["order_index"] or 0)),
                "是" if int(row["is_protected"] or 0) else "否",
                item_id,
                summaries_by_scope.get(f"category:{item_id}", ""),
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
