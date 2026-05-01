#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

from sqlite_migration_lib import load_schema, prepare_database, repo_root_from_script


FIREBASE_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
FIREBASE_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a Firebase/Firestore user into a SQLite database.")
    parser.add_argument("--db", required=True, help="Target SQLite database path.")
    parser.add_argument("--uid", default="", help="Target Firebase Auth uid.")
    parser.add_argument("--email", default="", help="Resolve target uid by email.")
    parser.add_argument("--emulator", action="store_true", help="Read from Firebase Emulator.")
    parser.add_argument("--production", action="store_true", help="Read from production Firebase.")
    parser.add_argument("--env-file", default=".env", help="Env file path. Default: ./ .env")
    parser.add_argument("--host", default="", help="Override Emulator host.")
    parser.add_argument("--auth-port", type=int, default=0, help="Override Auth Emulator port.")
    parser.add_argument("--firestore-port", type=int, default=0, help="Override Firestore Emulator port.")
    parser.add_argument("--project", default="", help="Override Firebase project id.")
    parser.add_argument("--replace", action="store_true", help="Replace the target database if it already exists.")
    return parser.parse_args()


def parse_env_file(file_path: Path) -> dict[str, str]:
    if not file_path.exists():
        return {}
    values: dict[str, str] = {}
    for line in file_path.read_text(encoding="utf-8").replace("\ufeff", "").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, raw_value = text.split("=", 1)
        values[key.strip()] = raw_value.strip().strip("'\"")
    return values


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def get_default_project_id() -> str:
    firebaserc_path = Path.cwd() / ".firebaserc"
    if not firebaserc_path.exists():
        return ""
    return str(read_json(firebaserc_path).get("projects", {}).get("default", ""))


def to_bool(value: str, fallback: bool = False) -> bool:
    text = str(value or "").strip().lower()
    if not text:
        return fallback
    return text in {"1", "true", "yes", "on"}


def build_runtime(args: argparse.Namespace, env_config: dict[str, str]) -> dict[str, object]:
    use_emulator = args.emulator or (not args.production and to_bool(env_config.get("FIREBASE_USE_EMULATORS", ""), False))
    project_id = args.project or env_config.get("FIREBASE_PROJECT_ID", "") or get_default_project_id()
    host = args.host or env_config.get("FIREBASE_EMULATOR_HOST", "") or "127.0.0.1"
    auth_port = args.auth_port or int(env_config.get("FIREBASE_AUTH_EMULATOR_PORT", "9099") or 9099)
    firestore_port = args.firestore_port or int(env_config.get("FIREBASE_FIRESTORE_EMULATOR_PORT", "8080") or 8080)
    if not project_id:
        raise SystemExit("找不到 Firebase project id，請確認 .firebaserc、.env 或 --project。")
    return {
        "use_emulator": use_emulator,
        "project_id": project_id,
        "host": host,
        "auth_port": auth_port,
        "firestore_port": firestore_port,
    }


def validate_args(args: argparse.Namespace) -> None:
    if not args.uid and not args.email:
        raise SystemExit("請至少指定 --uid 或 --email 其中一個。")
    if args.emulator and args.production:
        raise SystemExit("--emulator 與 --production 不能同時指定。")


def get_refresh_token() -> str:
    config_path = Path.home() / ".config" / "configstore" / "firebase-tools.json"
    payload = read_json(config_path)
    refresh_token = str(payload.get("tokens", {}).get("refresh_token", ""))
    if not refresh_token:
        raise SystemExit("找不到 Firebase CLI refresh token。請先執行 npm run firebase:login。")
    return refresh_token


def get_access_token() -> str:
    body = urllib.parse.urlencode(
        {
            "client_id": FIREBASE_CLIENT_ID,
            "client_secret": FIREBASE_CLIENT_SECRET,
            "refresh_token": get_refresh_token(),
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"content-type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        payload = json.loads(response.read().decode("utf-8"))
    access_token = str(payload.get("access_token", ""))
    if not access_token:
        raise SystemExit("取得 access token 失敗。")
    return access_token


def decode_firestore_value(value: dict) -> object:
    if "stringValue" in value:
        return value["stringValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "booleanValue" in value:
        return bool(value["booleanValue"])
    if "nullValue" in value:
        return None
    if "mapValue" in value:
        return decode_firestore_fields(value.get("mapValue", {}).get("fields", {}))
    if "arrayValue" in value:
        return [decode_firestore_value(item) for item in value.get("arrayValue", {}).get("values", [])]
    return ""


def decode_firestore_fields(fields: dict) -> dict:
    return {key: decode_firestore_value(value) for key, value in (fields or {}).items()}


def fetch_json(url: str, headers: dict[str, str] | None = None) -> dict:
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code}: {payload}") from exc


def firestore_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"} if access_token else {}


def get_firestore_documents_base(runtime: dict[str, object]) -> str:
    if runtime["use_emulator"]:
        return f"http://{runtime['host']}:{runtime['firestore_port']}/v1/projects/{runtime['project_id']}/databases/(default)/documents"
    return f"https://firestore.googleapis.com/v1/projects/{runtime['project_id']}/databases/(default)/documents"


def list_collection_documents(runtime: dict[str, object], access_token: str, collection_path: str) -> list[dict]:
    documents: list[dict] = []
    page_token = ""
    while True:
        query = {"pageSize": "500"}
        if page_token:
            query["pageToken"] = page_token
        url = f"{get_firestore_documents_base(runtime)}/{collection_path}?{urllib.parse.urlencode(query)}"
        payload = fetch_json(url, firestore_headers(access_token))
        for document in payload.get("documents", []):
            documents.append(
                {
                    "id": document["name"].split("/")[-1],
                    **decode_firestore_fields(document.get("fields", {})),
                }
            )
        page_token = str(payload.get("nextPageToken", ""))
        if not page_token:
            break
    return documents


def get_document(runtime: dict[str, object], access_token: str, document_path: str) -> dict | None:
    url = f"{get_firestore_documents_base(runtime)}/{document_path}"
    try:
        payload = fetch_json(url, firestore_headers(access_token))
    except SystemExit as exc:
        if "HTTP 404" in str(exc):
            return None
        raise
    return {
        "id": payload["name"].split("/")[-1],
        **decode_firestore_fields(payload.get("fields", {})),
    }


def export_auth_users(runtime: dict[str, object]) -> list[dict]:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as handle:
        temp_path = Path(handle.name)
    try:
        env = os.environ.copy()
        if runtime["use_emulator"]:
            env["FIREBASE_AUTH_EMULATOR_HOST"] = f"{runtime['host']}:{runtime['auth_port']}"
        subprocess.run(
            [
                "npx",
                "--yes",
                "firebase-tools",
                "auth:export",
                str(temp_path),
                "--format=json",
                "--project",
                str(runtime["project_id"]),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        return read_json(temp_path).get("users", [])
    finally:
        if temp_path.exists():
            temp_path.unlink()


def resolve_target_user(runtime: dict[str, object], args: argparse.Namespace) -> dict[str, str]:
    if args.uid and not args.email:
        return {"uid": args.uid, "email": "", "display_name": ""}

    users = export_auth_users(runtime)
    if args.uid:
        matched = next((user for user in users if str(user.get("localId", "")) == args.uid), None)
    else:
        lower_email = args.email.lower()
        matched = next((user for user in users if str(user.get("email", "")).lower() == lower_email), None)
    if not matched:
        key = args.uid or args.email
        raise SystemExit(f"找不到目標 Firebase Auth 使用者：{key}")
    return {
        "uid": str(matched.get("localId", "")),
        "email": str(matched.get("email", "")),
        "display_name": str(matched.get("displayName", "")),
    }


def normalize_int(value: object, default: int = 0) -> int:
    if value is None or value == "":
        return default
    return int(value)


def write_sqlite(
    db_path: Path,
    replace: bool,
    user: dict[str, str],
    settings: dict | None,
    accounts: list[dict],
    categories: list[dict],
    recurring: list[dict],
    transactions: list[dict],
    monthly_snapshots: list[dict],
) -> None:
    repo_root = repo_root_from_script(__file__)
    schema_sql = load_schema(repo_root / "sqlite" / "schema.sql")
    connection = prepare_database(db_path, schema_sql, replace)
    try:
        connection.execute(
            "INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)",
            (user["uid"], user["email"], user["display_name"]),
        )
        settings_payload = settings or {}
        connection.execute(
            """
            INSERT INTO user_settings (
              user_id, monthly_budget, recurring_applied_month, snapshot_dirty_from_month, legacy_transactions_checked_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                user["uid"],
                normalize_int(settings_payload.get("monthlyBudget"), 0),
                str(settings_payload.get("recurringAppliedMonth", "") or ""),
                str(settings_payload.get("snapshotDirtyFromMonth", "") or ""),
                normalize_int(settings_payload.get("legacyTransactionsCheckedAt"), 0),
            ),
        )

        for account in accounts:
            connection.execute(
                """
                INSERT INTO accounts (id, user_id, name, type, currency, opening_balance, order_index, is_protected, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(account["id"]),
                    user["uid"],
                    str(account.get("name", "") or ""),
                    str(account.get("type", "") or ""),
                    str(account.get("currency", "TWD") or "TWD"),
                    normalize_int(account.get("balance"), 0),
                    normalize_int(account.get("order"), 0),
                    1 if bool(account.get("protected")) else 0,
                    normalize_int(account.get("createdAt"), 0),
                    normalize_int(account.get("createdAt"), 0),
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
                    normalize_int(category.get("order"), 0),
                    1 if bool(category.get("protected")) else 0,
                    normalize_int(category.get("createdAt"), 0),
                    normalize_int(category.get("createdAt"), 0),
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
                    normalize_int(item.get("amount"), 0),
                    normalize_int(item.get("day"), 0),
                    normalize_int(item.get("createdAt"), 0),
                    normalize_int(item.get("createdAt"), 0),
                ),
            )

        for item in transactions:
            connection.execute(
                """
                INSERT INTO transactions (
                  id, user_id, txn_date, from_kind, from_id, to_kind, to_id, from_amount, to_amount, note, memo, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(item["id"]),
                    user["uid"],
                    str(item.get("date", "") or ""),
                    str(item.get("fromItem", {}).get("kind", "") or ""),
                    str(item.get("fromItem", {}).get("id", "") or ""),
                    str(item.get("toItem", {}).get("kind", "") or ""),
                    str(item.get("toItem", {}).get("id", "") or ""),
                    normalize_int(item.get("fromAmount", item.get("amount")), 0),
                    normalize_int(item.get("toAmount", item.get("amount")), 0),
                    str(item.get("note", "") or ""),
                    str(item.get("memo", "") or ""),
                    normalize_int(item.get("createdAt"), 0),
                    normalize_int(item.get("createdAt"), 0),
                ),
            )

        for snapshot in monthly_snapshots:
            connection.execute(
                """
                INSERT INTO monthly_snapshots (
                  user_id, month, closing_balances_json, closing_base_values_json, closing_fx_rates_json,
                  income_total, expense_total, category_totals_json, net_worth, transaction_count, source_last_transaction_date, rebuilt_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user["uid"],
                    str(snapshot.get("month", "") or ""),
                    json.dumps(snapshot.get("closingBalances", {}) or {}, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(snapshot.get("closingBaseValues", {}) or {}, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(snapshot.get("closingFxRates", {}) or {}, ensure_ascii=False, separators=(",", ":")),
                    normalize_int(snapshot.get("incomeTotal"), 0),
                    normalize_int(snapshot.get("expenseTotal"), 0),
                    json.dumps(snapshot.get("categoryTotals", {}) or {}, ensure_ascii=False, separators=(",", ":")),
                    normalize_int(snapshot.get("netWorth"), 0),
                    normalize_int(snapshot.get("transactionCount"), 0),
                    str(snapshot.get("sourceLastTransactionDate", "") or ""),
                    normalize_int(snapshot.get("rebuiltAt"), 0),
                ),
            )

        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> int:
    args = parse_args()
    validate_args(args)
    env_config = parse_env_file(Path(args.env_file).expanduser().resolve())
    runtime = build_runtime(args, env_config)
    target_user = resolve_target_user(runtime, args)
    access_token = "" if runtime["use_emulator"] else get_access_token()
    uid = target_user["uid"]

    accounts = list_collection_documents(runtime, access_token, f"users/{uid}/accounts")
    categories = list_collection_documents(runtime, access_token, f"users/{uid}/categories")
    recurring = list_collection_documents(runtime, access_token, f"users/{uid}/recurring")
    transactions = list_collection_documents(runtime, access_token, f"users/{uid}/transactions")
    monthly_snapshots = list_collection_documents(runtime, access_token, f"users/{uid}/monthlySnapshots")
    settings = get_document(runtime, access_token, f"users/{uid}/meta/settings")

    db_path = Path(args.db).expanduser().resolve()
    write_sqlite(db_path, args.replace, target_user, settings, accounts, categories, recurring, transactions, monthly_snapshots)

    print(f"SQLite database created: {db_path}")
    print(f"User: {uid}")
    print(f"Accounts: {len(accounts)}")
    print(f"Categories: {len(categories)}")
    print(f"Recurring: {len(recurring)}")
    print(f"Transactions: {len(transactions)}")
    print(f"Monthly snapshots: {len(monthly_snapshots)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
