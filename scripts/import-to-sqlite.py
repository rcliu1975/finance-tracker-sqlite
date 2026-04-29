#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import sqlite3
import sys
from pathlib import Path

from sqlite_migration_lib import connect_sqlite, load_schema, read_csv_rows, repo_root_from_script, prepare_database


def load_script_module(script_name: str, module_name: str):
    script_dir = Path(__file__).resolve().parent
    script_path = script_dir / script_name
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"無法載入腳本模組：{script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CSV_IMPORT = load_script_module("import-csv-to-sqlite.py", "import_csv_to_sqlite")
ITEM_IMPORT = load_script_module("import-items-to-sqlite.py", "import_items_to_sqlite")
FIRESTORE_IMPORT = load_script_module("export-firestore-to-sqlite.py", "export_firestore_to_sqlite")
SNAPSHOTS = load_script_module("rebuild-sqlite-snapshots.py", "rebuild_sqlite_snapshots")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Unified SQLite import entrypoint.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    csv_parser = subparsers.add_parser("csv", help="Import items + transactions CSV into SQLite.")
    csv_parser.add_argument("--db", required=True, help="Target SQLite database path.")
    csv_parser.add_argument("--items-csv", required=True, help="Items CSV path.")
    csv_parser.add_argument("--transactions-csv", required=True, help="Transactions CSV path.")
    csv_parser.add_argument("--user-id", default="local-user", help="Logical user id stored in SQLite.")
    csv_parser.add_argument("--user-email", default="", help="Optional user email stored in SQLite.")
    csv_parser.add_argument("--display-name", default="Local User", help="Optional display name stored in SQLite.")
    csv_parser.add_argument("--replace", action="store_true", help="Replace the target database if it already exists.")

    items_parser = subparsers.add_parser("items", help="Import item settings CSV into an existing SQLite database.")
    items_parser.add_argument("--db", required=True, help="SQLite database path.")
    items_parser.add_argument("--items-csv", required=True, help="Items CSV path.")
    items_parser.add_argument("--user-id", default="", help="Optional user id override. Defaults to the first user in the database.")

    firestore_parser = subparsers.add_parser("firestore", help="Import a Firebase / Firestore user into SQLite.")
    firestore_parser.add_argument("--db", required=True, help="Target SQLite database path.")
    firestore_parser.add_argument("--uid", default="", help="Target Firebase Auth uid.")
    firestore_parser.add_argument("--email", default="", help="Resolve target uid by email.")
    firestore_parser.add_argument("--emulator", action="store_true", help="Read from Firebase Emulator.")
    firestore_parser.add_argument("--production", action="store_true", help="Read from production Firebase.")
    firestore_parser.add_argument("--env-file", default=".env", help="Env file path. Default: ./ .env")
    firestore_parser.add_argument("--host", default="", help="Override Emulator host.")
    firestore_parser.add_argument("--auth-port", type=int, default=0, help="Override Auth Emulator port.")
    firestore_parser.add_argument("--firestore-port", type=int, default=0, help="Override Firestore Emulator port.")
    firestore_parser.add_argument("--project", default="", help="Override Firebase project id.")
    firestore_parser.add_argument("--replace", action="store_true", help="Replace the target database if it already exists.")

    return parser


def open_database(db_path: Path, replace: bool) -> sqlite3.Connection:
    if replace or not db_path.exists():
        schema_sql = load_schema(repo_root_from_script(__file__) / "sqlite" / "schema.sql")
        return prepare_database(db_path, schema_sql, replace)
    return connect_sqlite(db_path)


def ensure_user(connection: sqlite3.Connection, user_id: str, user_email: str = "", display_name: str = "") -> None:
    existing = connection.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if existing:
        connection.execute(
            """
            UPDATE users
            SET email = COALESCE(NULLIF(?, ''), email),
                display_name = COALESCE(NULLIF(?, ''), display_name)
            WHERE id = ?
            """,
            (user_email, display_name, user_id),
        )
    else:
        connection.execute(
            "INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)",
            (user_id, user_email, display_name),
        )

    settings = connection.execute("SELECT user_id FROM user_settings WHERE user_id = ?", (user_id,)).fetchone()
    if not settings:
        connection.execute(
            """
            INSERT INTO user_settings (
              user_id, monthly_budget, recurring_applied_month, snapshot_dirty_from_month, legacy_transactions_checked_at
            ) VALUES (?, 0, '', '', 0)
            """,
            (user_id,),
        )


def require_no_transactions(connection: sqlite3.Connection, user_id: str) -> None:
    row = connection.execute("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?", (user_id,)).fetchone()
    if row and int(row["count"] or 0) > 0:
        raise RuntimeError(f"拒絕匯入：user `{user_id}` 在資料庫內已存在 transaction 記錄。")


def clear_user_data(connection: sqlite3.Connection, user_id: str) -> None:
    for table in [
        "common_summaries",
        "recurring_entries",
        "monthly_snapshots",
        "transactions",
        "accounts",
        "categories",
    ]:
        connection.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
    connection.execute(
        """
        UPDATE user_settings
        SET monthly_budget = 0,
            recurring_applied_month = '',
            snapshot_dirty_from_month = '',
            legacy_transactions_checked_at = 0,
            updated_at = unixepoch()
        WHERE user_id = ?
        """,
        (user_id,),
    )


def rebuild_snapshots(connection: sqlite3.Connection, user_id: str, from_month: str = "") -> dict:
    settings = connection.execute(
        "SELECT snapshot_dirty_from_month FROM user_settings WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    accounts, categories = SNAPSHOTS.load_items(connection, user_id)
    accounts_by_id = {item["id"]: item for item in accounts}
    categories_by_id = {item["id"]: item for item in categories}
    transactions = SNAPSHOTS.load_transactions(connection, user_id, accounts_by_id, categories_by_id)
    dirty_from_month = str(settings["snapshot_dirty_from_month"] or "") if settings else ""
    summary = SNAPSHOTS.build_snapshots(accounts, transactions, from_month, dirty_from_month)
    connection.execute("DELETE FROM monthly_snapshots WHERE user_id = ?", (user_id,))
    if summary["snapshots"]:
        SNAPSHOTS.persist_snapshots(connection, user_id, summary["snapshots"])
    else:
        connection.execute(
            """
            UPDATE user_settings
            SET snapshot_dirty_from_month = '', updated_at = unixepoch()
            WHERE user_id = ?
            """,
            (user_id,),
        )
    return summary


def import_csv_command(args: argparse.Namespace) -> int:
    db_path = Path(args.db).expanduser().resolve()
    items_path = Path(args.items_csv).expanduser().resolve()
    transactions_path = Path(args.transactions_csv).expanduser().resolve()
    if not items_path.exists():
        raise FileNotFoundError(f"找不到 items CSV：{items_path}")
    if not transactions_path.exists():
        raise FileNotFoundError(f"找不到 transactions CSV：{transactions_path}")

    item_rows = read_csv_rows(items_path)
    transaction_rows = read_csv_rows(transactions_path)
    connection = open_database(db_path, args.replace)
    try:
        ensure_user(connection, args.user_id, args.user_email.strip(), args.display_name.strip())
        if not args.replace:
            require_no_transactions(connection, args.user_id)
            clear_user_data(connection, args.user_id)
        item_refs = CSV_IMPORT.import_items(connection, item_rows, args.user_id)
        transaction_count = CSV_IMPORT.import_transactions(connection, transaction_rows, args.user_id, item_refs)
        snapshot_summary = rebuild_snapshots(connection, args.user_id)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    print(f"SQLite database updated: {db_path}")
    print(f"Items imported: {len(item_refs)}")
    print(f"Transactions imported: {transaction_count}")
    print(f"Snapshots rebuilt: {len(snapshot_summary['snapshots'])}")
    return 0


def import_items_command(args: argparse.Namespace) -> int:
    db_path = Path(args.db).expanduser().resolve()
    items_path = Path(args.items_csv).expanduser().resolve()
    if not items_path.exists():
        raise FileNotFoundError(f"找不到 items CSV：{items_path}")

    rows = read_csv_rows(items_path)
    connection = connect_sqlite(db_path)
    try:
        user_id = ITEM_IMPORT.read_user_id(connection, args.user_id)
        require_no_transactions(connection, user_id)
        created_count, updated_count, skipped_count, dirty_month = ITEM_IMPORT.import_items(connection, user_id, rows)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    print(f"Items imported into: {db_path}")
    print(f"Created: {created_count}")
    print(f"Updated: {updated_count}")
    print(f"Skipped: {skipped_count}")
    if dirty_month:
        print(f"Snapshot dirty from month: {dirty_month}")
    return 0


def write_firestore_payload(
    connection: sqlite3.Connection,
    user: dict[str, str],
    settings: dict | None,
    accounts: list[dict],
    categories: list[dict],
    recurring: list[dict],
    transactions: list[dict],
) -> None:
    ensure_user(connection, user["uid"], user["email"], user["display_name"])
    connection.execute(
        """
        UPDATE user_settings
        SET monthly_budget = ?,
            recurring_applied_month = ?,
            snapshot_dirty_from_month = ?,
            legacy_transactions_checked_at = ?,
            updated_at = unixepoch()
        WHERE user_id = ?
        """,
        (
            int((settings or {}).get("monthlyBudget", 0) or 0),
            str((settings or {}).get("recurringAppliedMonth", "") or ""),
            str((settings or {}).get("snapshotDirtyFromMonth", "") or ""),
            int((settings or {}).get("legacyTransactionsCheckedAt", 0) or 0),
            user["uid"],
        ),
    )

    for account in accounts:
        connection.execute(
            """
            INSERT INTO accounts (id, user_id, name, type, opening_balance, order_index, is_protected, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(account["id"]),
                user["uid"],
                str(account.get("name", "") or ""),
                str(account.get("type", "") or ""),
                int(account.get("balance", 0) or 0),
                int(account.get("order", 0) or 0),
                1 if bool(account.get("protected")) else 0,
                int(account.get("createdAt", 0) or 0),
                int(account.get("createdAt", 0) or 0),
            ),
        )

    for category in categories:
        connection.execute(
            """
            INSERT INTO categories (id, user_id, name, type, order_index, is_protected, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(category["id"]),
                user["uid"],
                str(category.get("name", "") or ""),
                str(category.get("type", "") or ""),
                int(category.get("order", 0) or 0),
                1 if bool(category.get("protected")) else 0,
                int(category.get("createdAt", 0) or 0),
                int(category.get("createdAt", 0) or 0),
            ),
        )

    for item in recurring:
        connection.execute(
            """
            INSERT INTO recurring_entries (id, user_id, name, account_id, category_id, amount, day_of_month, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(item["id"]),
                user["uid"],
                str(item.get("name", "") or ""),
                str(item.get("accountId", "") or ""),
                str(item.get("categoryId", "") or ""),
                int(item.get("amount", 0) or 0),
                int(item.get("day", 0) or 0),
                int(item.get("createdAt", 0) or 0),
                int(item.get("createdAt", 0) or 0),
            ),
        )

    for item in transactions:
        connection.execute(
            """
            INSERT INTO transactions (
              id, user_id, txn_date, from_kind, from_id, to_kind, to_id, amount, note, memo, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(item["id"]),
                user["uid"],
                str(item.get("date", "") or ""),
                str(item.get("fromItem", {}).get("kind", "") or ""),
                str(item.get("fromItem", {}).get("id", "") or ""),
                str(item.get("toItem", {}).get("kind", "") or ""),
                str(item.get("toItem", {}).get("id", "") or ""),
                int(item.get("amount", 0) or 0),
                str(item.get("note", "") or ""),
                str(item.get("memo", "") or ""),
                int(item.get("createdAt", 0) or 0),
                int(item.get("createdAt", 0) or 0),
            ),
        )


def import_firestore_command(args: argparse.Namespace) -> int:
    FIRESTORE_IMPORT.validate_args(args)
    env_config = FIRESTORE_IMPORT.parse_env_file(Path(args.env_file).expanduser().resolve())
    runtime = FIRESTORE_IMPORT.build_runtime(args, env_config)
    target_user = FIRESTORE_IMPORT.resolve_target_user(runtime, args)
    access_token = "" if runtime["use_emulator"] else FIRESTORE_IMPORT.get_access_token()
    uid = target_user["uid"]

    accounts = FIRESTORE_IMPORT.list_collection_documents(runtime, access_token, f"users/{uid}/accounts")
    categories = FIRESTORE_IMPORT.list_collection_documents(runtime, access_token, f"users/{uid}/categories")
    recurring = FIRESTORE_IMPORT.list_collection_documents(runtime, access_token, f"users/{uid}/recurring")
    transactions = FIRESTORE_IMPORT.list_collection_documents(runtime, access_token, f"users/{uid}/transactions")
    settings = FIRESTORE_IMPORT.get_document(runtime, access_token, f"users/{uid}/meta/settings")

    db_path = Path(args.db).expanduser().resolve()
    connection = open_database(db_path, args.replace)
    try:
        ensure_user(connection, uid, target_user["email"], target_user["display_name"])
        if not args.replace:
            require_no_transactions(connection, uid)
            clear_user_data(connection, uid)
        write_firestore_payload(connection, target_user, settings, accounts, categories, recurring, transactions)
        snapshot_summary = rebuild_snapshots(connection, uid)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    print(f"SQLite database updated: {db_path}")
    print(f"User: {uid}")
    print(f"Accounts imported: {len(accounts)}")
    print(f"Categories imported: {len(categories)}")
    print(f"Recurring imported: {len(recurring)}")
    print(f"Transactions imported: {len(transactions)}")
    print(f"Snapshots rebuilt: {len(snapshot_summary['snapshots'])}")
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "csv":
        return import_csv_command(args)
    if args.command == "items":
        return import_items_command(args)
    if args.command == "firestore":
        return import_firestore_command(args)
    raise RuntimeError(f"未知命令：{args.command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
