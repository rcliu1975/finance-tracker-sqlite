#!/usr/bin/env python3
"""
Verify a generated SQLite database at a coarse level.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sqlite3

from sqlite_migration_lib import TABLES, connect_sqlite


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify imported finance SQLite database.")
    parser.add_argument("--db", required=True, help="SQLite database path.")
    return parser.parse_args()


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

        user = conn.execute("SELECT id, email, display_name FROM users LIMIT 1").fetchone()
        if user:
            print("user:", dict(user))

        sample_txn = conn.execute(
            """
            SELECT txn_date, amount, note, substr(replace(memo, char(10), ' / '), 1, 80) AS memo_preview
            FROM transactions
            ORDER BY rowid
            LIMIT 3
            """
        ).fetchall()
        print("sample transactions:")
        for row in sample_txn:
            print("  ", dict(row))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
