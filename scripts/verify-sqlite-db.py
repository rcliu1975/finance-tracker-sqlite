#!/usr/bin/env python3
"""
Verify a generated SQLite database at a coarse level.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sqlite3

from sqlite_migration_lib import TABLES, connect_sqlite, has_column


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify imported finance SQLite database.")
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--user-id", default="", help="Target user id. Default: first user.")
    return parser.parse_args()


def load_snapshot_rows(conn: sqlite3.Connection, user_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT month, net_worth, income_total, expense_total, closing_base_values_json
        FROM monthly_snapshots
        WHERE user_id = ?
        ORDER BY month ASC
        """,
        (user_id,),
    ).fetchall()


def print_reconciliation_summary(conn: sqlite3.Connection, user_id: str) -> None:
    snapshots = load_snapshot_rows(conn, user_id)
    if not snapshots:
        print("reconciliation: no monthly snapshots")
        return

    print("reconciliation:")
    start_index = max(0, len(snapshots) - 6)
    previous_net_worth = int(snapshots[start_index - 1]["net_worth"] or 0) if start_index > 0 else 0
    for row in snapshots[start_index:]:
        month = str(row["month"] or "")
        net_worth = int(row["net_worth"] or 0)
        income_total = int(row["income_total"] or 0)
        expense_total = int(row["expense_total"] or 0)
        net_worth_delta = net_worth - previous_net_worth
        operating_delta = income_total - expense_total
        fx_valuation_delta = net_worth_delta - operating_delta
        print(
            "  "
            f"{month}: "
            f"netWorthDelta={net_worth_delta} "
            f"operatingDelta={operating_delta} "
            f"fxValuationDelta={fx_valuation_delta}"
        )
        previous_net_worth = net_worth


def main() -> int:
    args = parse_args()
    db_path = Path(args.db).expanduser().resolve()
    if not db_path.exists():
        raise FileNotFoundError(f"找不到資料庫：{db_path}")

    conn = connect_sqlite(db_path)
    try:
        print(f"DB: {db_path}")
        print("table counts:")
        for table in TABLES:
            count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            print(f"  {table}: {count}")

        fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
        print(f"foreign_key_check: {'ok' if not fk_errors else len(fk_errors)}")
        if fk_errors:
            for row in fk_errors[:20]:
                print("  ", dict(row))

        user = (
            conn.execute("SELECT id, email, display_name FROM users WHERE id = ?", (args.user_id,)).fetchone()
            if args.user_id
            else conn.execute("SELECT id, email, display_name FROM users LIMIT 1").fetchone()
        )
        if user:
            print("user:", dict(user))
            print_reconciliation_summary(conn, str(user["id"]))

        sample_query = (
            """
            SELECT txn_date, from_amount, to_amount, note, substr(replace(memo, char(10), ' / '), 1, 80) AS memo_preview
            FROM transactions
            ORDER BY rowid
            LIMIT 3
            """
            if has_column(conn, "transactions", "from_amount") and has_column(conn, "transactions", "to_amount")
            else """
            SELECT txn_date, amount, note, substr(replace(memo, char(10), ' / '), 1, 80) AS memo_preview
            FROM transactions
            ORDER BY rowid
            LIMIT 3
            """
        )
        sample_txn = conn.execute(sample_query).fetchall()
        print("sample transactions:")
        for row in sample_txn:
            print("  ", dict(row))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
