#!/usr/bin/env python3
from __future__ import annotations

import argparse
import secrets
import importlib.util
import json
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from sqlite_migration_lib import connect_sqlite, next_id


def load_script_module(script_name: str, module_name: str):
    script_dir = Path(__file__).resolve().parent
    script_path = script_dir / script_name
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"無法載入腳本模組：{script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SNAPSHOTS = load_script_module("rebuild-sqlite-snapshots.py", "rebuild_sqlite_snapshots_bridge")

FAILED_LOGIN_WINDOW_SECONDS = 300
FAILED_LOGIN_MAX_ATTEMPTS = 5
FAILED_LOGIN_DELAY_SECONDS = 1.0
FAILED_LOGIN_LOCKOUT_SECONDS = 900


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Expose a SQLite finance database over a local HTTP bridge.")
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--user-id", default="local-user", help="Target user id.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="Bind port. Default: 8765")
    parser.add_argument("--login-email", default="", help="Enable UI login with this email.")
    parser.add_argument("--login-password", default="", help="Enable UI login with this password.")
    parser.add_argument("--session-ttl-seconds", type=int, default=43200, help="Bridge session token lifetime.")
    return parser.parse_args()


def settings_payload(row) -> dict:
    if not row:
        return {
            "monthlyBudget": 0,
            "recurringAppliedMonth": "",
            "snapshotDirtyFromMonth": "",
            "legacyTransactionsCheckedAt": 0,
        }
    return {
        "monthlyBudget": int(row["monthly_budget"] or 0),
        "recurringAppliedMonth": str(row["recurring_applied_month"] or ""),
        "snapshotDirtyFromMonth": str(row["snapshot_dirty_from_month"] or ""),
        "legacyTransactionsCheckedAt": int(row["legacy_transactions_checked_at"] or 0),
    }


def load_settings(conn, user_id: str):
    row = conn.execute(
        """
        SELECT monthly_budget, recurring_applied_month, snapshot_dirty_from_month, legacy_transactions_checked_at
        FROM user_settings
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchone()
    return settings_payload(row)


def load_accounts(conn, user_id: str):
    rows = conn.execute(
        """
        SELECT id, name, type, opening_balance, order_index, created_at, is_protected
        FROM accounts
        WHERE user_id = ?
        ORDER BY order_index ASC, created_at ASC, id ASC
        """,
        (user_id,),
    ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "name": str(row["name"] or ""),
            "type": str(row["type"] or ""),
            "balance": int(row["opening_balance"] or 0),
            "order": int(row["order_index"] or 0),
            "createdAt": int(row["created_at"] or 0),
            "protected": bool(row["is_protected"]),
        }
        for row in rows
    ]


def load_categories(conn, user_id: str):
    rows = conn.execute(
        """
        SELECT id, name, type, order_index, created_at, is_protected
        FROM categories
        WHERE user_id = ?
        ORDER BY order_index ASC, created_at ASC, id ASC
        """,
        (user_id,),
    ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "name": str(row["name"] or ""),
            "type": str(row["type"] or ""),
            "order": int(row["order_index"] or 0),
            "createdAt": int(row["created_at"] or 0),
            "protected": bool(row["is_protected"]),
        }
        for row in rows
    ]


def load_recurring(conn, user_id: str):
    rows = conn.execute(
        """
        SELECT id, name, account_id, category_id, amount, day_of_month, created_at
        FROM recurring_entries
        WHERE user_id = ?
        ORDER BY day_of_month ASC, created_at ASC, id ASC
        """,
        (user_id,),
    ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "name": str(row["name"] or ""),
            "accountId": str(row["account_id"] or ""),
            "categoryId": str(row["category_id"] or ""),
            "amount": int(row["amount"] or 0),
            "day": int(row["day_of_month"] or 0),
            "createdAt": int(row["created_at"] or 0),
        }
        for row in rows
    ]


def item_maps(conn, user_id: str):
    accounts = {item["id"]: item for item in load_accounts(conn, user_id)}
    categories = {item["id"]: item for item in load_categories(conn, user_id)}
    return accounts, categories


def build_item_ref(kind: str, item_id: str, accounts: dict, categories: dict) -> dict:
    if kind == "account":
        item = accounts.get(item_id, {})
    else:
        item = categories.get(item_id, {})
    return {
        "kind": kind,
        "id": item_id,
        "name": str(item.get("name", "")),
        "type": str(item.get("type", "")),
    }


def load_transactions(conn, user_id: str, start_date: str = "", end_date: str = ""):
    accounts, categories = item_maps(conn, user_id)
    conditions = ["user_id = ?"]
    params: list[object] = [user_id]
    if start_date:
        conditions.append("txn_date >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("txn_date <= ?")
        params.append(end_date)
    rows = conn.execute(
        f"""
        SELECT id, txn_date, from_kind, from_id, to_kind, to_id, amount, note, memo, created_at
        FROM transactions
        WHERE {' AND '.join(conditions)}
        ORDER BY txn_date DESC, created_at DESC, id DESC
        """,
        tuple(params),
    ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "date": str(row["txn_date"] or ""),
            "fromItem": build_item_ref(str(row["from_kind"] or ""), str(row["from_id"] or ""), accounts, categories),
            "toItem": build_item_ref(str(row["to_kind"] or ""), str(row["to_id"] or ""), accounts, categories),
            "amount": int(row["amount"] or 0),
            "note": str(row["note"] or ""),
            "memo": str(row["memo"] or ""),
            "createdAt": int(row["created_at"] or 0),
        }
        for row in rows
    ]


def load_snapshot_by_month(conn, user_id: str, month: str):
    row = conn.execute(
        """
        SELECT month, closing_balances_json, income_total, expense_total, category_totals_json,
               net_worth, transaction_count, source_last_transaction_date, rebuilt_at
        FROM monthly_snapshots
        WHERE user_id = ? AND month = ?
        """,
        (user_id, month),
    ).fetchone()
    if not row:
        return None
    return {
        "id": str(row["month"]),
        "month": str(row["month"] or ""),
        "closingBalances": json.loads(str(row["closing_balances_json"] or "{}")),
        "incomeTotal": int(row["income_total"] or 0),
        "expenseTotal": int(row["expense_total"] or 0),
        "categoryTotals": json.loads(str(row["category_totals_json"] or "{}")),
        "netWorth": int(row["net_worth"] or 0),
        "transactionCount": int(row["transaction_count"] or 0),
        "sourceLastTransactionDate": str(row["source_last_transaction_date"] or ""),
        "rebuiltAt": int(row["rebuilt_at"] or 0),
    }


def load_latest_snapshot_before(conn, user_id: str, month: str):
    row = conn.execute(
        """
        SELECT month
        FROM monthly_snapshots
        WHERE user_id = ? AND month < ?
        ORDER BY month DESC
        LIMIT 1
        """,
        (user_id, month),
    ).fetchone()
    if not row:
        return None
    return load_snapshot_by_month(conn, user_id, str(row["month"]))


def load_history_metadata(conn, user_id: str):
    transaction_row = conn.execute(
        "SELECT substr(MIN(txn_date), 1, 7) AS month, COUNT(*) AS count FROM transactions WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    snapshot_row = conn.execute(
        "SELECT MIN(month) AS month FROM monthly_snapshots WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    return {
        "hasTransactions": int((transaction_row["count"] or 0) if transaction_row else 0) > 0,
        "earliestTransactionMonth": str((transaction_row["month"] or "") if transaction_row else ""),
        "earliestSnapshotMonth": str((snapshot_row["month"] or "") if snapshot_row else ""),
    }


def load_common_summaries(conn, user_id: str):
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
    return grouped


def replace_common_summaries(conn, user_id: str, payload: dict):
    conn.execute("DELETE FROM common_summaries WHERE user_id = ?", (user_id,))
    rows = []
    for scope_key, summaries in (payload or {}).items():
        unique = []
        for summary in summaries if isinstance(summaries, list) else []:
            text = str(summary or "").strip()
            if text and text not in unique:
                unique.append(text)
        for index, summary in enumerate(unique[:6]):
            rows.append((user_id, str(scope_key or ""), index, summary))
    if rows:
        conn.executemany(
            """
            INSERT INTO common_summaries (user_id, scope_key, order_index, summary)
            VALUES (?, ?, ?, ?)
            """,
            rows,
        )


def rebuild_monthly_snapshots(conn, user_id: str, from_month: str = ""):
    settings = conn.execute(
        "SELECT snapshot_dirty_from_month FROM user_settings WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    accounts, categories = SNAPSHOTS.load_items(conn, user_id)
    accounts_by_id = {item["id"]: item for item in accounts}
    categories_by_id = {item["id"]: item for item in categories}
    transactions = SNAPSHOTS.load_transactions(conn, user_id, accounts_by_id, categories_by_id)
    dirty_from_month = str(settings["snapshot_dirty_from_month"] or "") if settings else ""
    summary = SNAPSHOTS.build_snapshots(accounts, transactions, from_month, dirty_from_month)
    conn.execute("DELETE FROM monthly_snapshots WHERE user_id = ?", (user_id,))
    if summary["snapshots"]:
        SNAPSHOTS.persist_snapshots(conn, user_id, summary["snapshots"])
    else:
        conn.execute(
            """
            UPDATE user_settings
            SET snapshot_dirty_from_month = '', updated_at = unixepoch()
            WHERE user_id = ?
            """,
            (user_id,),
        )
    return summary


def sqlite_bridge_status(conn, user_id: str, db_path: Path):
    return {
        "dbPath": str(db_path),
        "userId": user_id,
        "settings": load_settings(conn, user_id),
        "history": load_history_metadata(conn, user_id),
        "counts": {
            "accounts": len(load_accounts(conn, user_id)),
            "categories": len(load_categories(conn, user_id)),
            "recurring": len(load_recurring(conn, user_id)),
            "transactions": conn.execute("SELECT COUNT(*) FROM transactions WHERE user_id = ?", (user_id,)).fetchone()[0],
            "monthlySnapshots": conn.execute("SELECT COUNT(*) FROM monthly_snapshots WHERE user_id = ?", (user_id,)).fetchone()[0],
            "commonSummaries": conn.execute("SELECT COUNT(*) FROM common_summaries WHERE user_id = ?", (user_id,)).fetchone()[0],
        },
    }


def bridge_user_payload(email: str, user_id: str) -> dict:
    email_text = str(email or "").strip()
    display_name = email_text.split("@")[0] if "@" in email_text else email_text or user_id
    return {
        "uid": user_id,
        "email": email_text,
        "displayName": display_name,
    }


def ensure_settings_row(conn, user_id: str):
    row = conn.execute("SELECT user_id FROM user_settings WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        conn.execute(
            """
            INSERT INTO user_settings (
              user_id, monthly_budget, recurring_applied_month, snapshot_dirty_from_month, legacy_transactions_checked_at
            ) VALUES (?, 0, '', '', 0)
            """,
            (user_id,),
        )


def upsert_account(conn, user_id: str, doc_id: str, payload: dict, partial: bool):
    if partial:
        current = conn.execute("SELECT * FROM accounts WHERE user_id = ? AND id = ?", (user_id, doc_id)).fetchone()
        if not current:
            raise KeyError(f"找不到 accounts/{doc_id}")
        payload = {
            "name": current["name"],
            "type": current["type"],
            "balance": current["opening_balance"],
            "order": current["order_index"],
            "createdAt": current["created_at"],
            "protected": bool(current["is_protected"]),
            **payload,
        }
    conn.execute(
        """
        INSERT INTO accounts (id, user_id, name, type, opening_balance, order_index, is_protected, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          opening_balance = excluded.opening_balance,
          order_index = excluded.order_index,
          is_protected = excluded.is_protected,
          updated_at = unixepoch()
        """,
        (
            doc_id,
            user_id,
            str(payload.get("name", "") or ""),
            str(payload.get("type", "") or ""),
            int(payload.get("balance", 0) or 0),
            int(payload.get("order", 0) or 0),
            1 if bool(payload.get("protected")) else 0,
            int(payload.get("createdAt", 0) or 0) or int(conn.execute("SELECT unixepoch()").fetchone()[0]),
        ),
    )


def upsert_category(conn, user_id: str, doc_id: str, payload: dict, partial: bool):
    if partial:
        current = conn.execute("SELECT * FROM categories WHERE user_id = ? AND id = ?", (user_id, doc_id)).fetchone()
        if not current:
            raise KeyError(f"找不到 categories/{doc_id}")
        payload = {
            "name": current["name"],
            "type": current["type"],
            "order": current["order_index"],
            "createdAt": current["created_at"],
            "protected": bool(current["is_protected"]),
            **payload,
        }
    conn.execute(
        """
        INSERT INTO categories (id, user_id, name, type, order_index, is_protected, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          order_index = excluded.order_index,
          is_protected = excluded.is_protected,
          updated_at = unixepoch()
        """,
        (
            doc_id,
            user_id,
            str(payload.get("name", "") or ""),
            str(payload.get("type", "") or ""),
            int(payload.get("order", 0) or 0),
            1 if bool(payload.get("protected")) else 0,
            int(payload.get("createdAt", 0) or 0) or int(conn.execute("SELECT unixepoch()").fetchone()[0]),
        ),
    )


def upsert_recurring(conn, user_id: str, doc_id: str, payload: dict, partial: bool):
    if partial:
        current = conn.execute("SELECT * FROM recurring_entries WHERE user_id = ? AND id = ?", (user_id, doc_id)).fetchone()
        if not current:
            raise KeyError(f"找不到 recurring/{doc_id}")
        payload = {
            "name": current["name"],
            "accountId": current["account_id"],
            "categoryId": current["category_id"],
            "amount": current["amount"],
            "day": current["day_of_month"],
            "createdAt": current["created_at"],
            **payload,
        }
    conn.execute(
        """
        INSERT INTO recurring_entries (id, user_id, name, account_id, category_id, amount, day_of_month, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          account_id = excluded.account_id,
          category_id = excluded.category_id,
          amount = excluded.amount,
          day_of_month = excluded.day_of_month,
          updated_at = unixepoch()
        """,
        (
            doc_id,
            user_id,
            str(payload.get("name", "") or ""),
            str(payload.get("accountId", "") or ""),
            str(payload.get("categoryId", "") or ""),
            int(payload.get("amount", 0) or 0),
            int(payload.get("day", 0) or 0),
            int(payload.get("createdAt", 0) or 0) or int(conn.execute("SELECT unixepoch()").fetchone()[0]),
        ),
    )


def upsert_transaction(conn, user_id: str, doc_id: str, payload: dict, partial: bool):
    if partial:
        current = conn.execute("SELECT * FROM transactions WHERE user_id = ? AND id = ?", (user_id, doc_id)).fetchone()
        if not current:
            raise KeyError(f"找不到 transactions/{doc_id}")
        payload = {
            "date": current["txn_date"],
            "fromItem": {"kind": current["from_kind"], "id": current["from_id"]},
            "toItem": {"kind": current["to_kind"], "id": current["to_id"]},
            "amount": current["amount"],
            "note": current["note"],
            "memo": current["memo"],
            "createdAt": current["created_at"],
            **payload,
        }
    conn.execute(
        """
        INSERT INTO transactions (
          id, user_id, txn_date, from_kind, from_id, to_kind, to_id, amount, note, memo, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          txn_date = excluded.txn_date,
          from_kind = excluded.from_kind,
          from_id = excluded.from_id,
          to_kind = excluded.to_kind,
          to_id = excluded.to_id,
          amount = excluded.amount,
          note = excluded.note,
          memo = excluded.memo,
          updated_at = unixepoch()
        """,
        (
            doc_id,
            user_id,
            str(payload.get("date", "") or ""),
            str(payload.get("fromItem", {}).get("kind", "") or ""),
            str(payload.get("fromItem", {}).get("id", "") or ""),
            str(payload.get("toItem", {}).get("kind", "") or ""),
            str(payload.get("toItem", {}).get("id", "") or ""),
            int(payload.get("amount", 0) or 0),
            str(payload.get("note", "") or ""),
            str(payload.get("memo", "") or ""),
            int(payload.get("createdAt", 0) or 0) or int(conn.execute("SELECT unixepoch()").fetchone()[0]),
        ),
    )


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "SQLiteBridge/1.0"

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_cors_headers()
        self.send_security_headers()
        self.end_headers()

    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")

    def do_PUT(self):
        self.handle_request("PUT")

    def do_PATCH(self):
        self.handle_request("PATCH")

    def do_DELETE(self):
        self.handle_request("DELETE")

    def handle_request(self, method: str):
        try:
            parsed = urlparse(self.path)
            payload = self.read_json_body() if method in {"POST", "PUT", "PATCH"} else None
            response = self.dispatch(method, parsed.path, parse_qs(parsed.query), payload)
            self.write_json(HTTPStatus.OK, response)
        except KeyError as exc:
            self.write_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
        except PermissionError as exc:
            self.write_json(HTTPStatus.UNAUTHORIZED, {"error": str(exc)})
        except ValueError as exc:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:
            self.write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})

    def dispatch(self, method: str, path: str, query: dict, payload: dict | None):
        if path == "/health":
            return {"status": "ok"}
        if path == "/session/config" and method == "GET":
            return {
                "supportsCredentialSession": bool(self.server.login_email and self.server.login_password),
                "providerLabel": "SQLite",
            }
        if path == "/session/login" and method == "POST":
            if not (self.server.login_email and self.server.login_password):
                raise ValueError("目前 bridge 沒有啟用登入模式。")
            client_id = self.get_client_identifier()
            self.ensure_login_allowed(client_id)
            email = str((payload or {}).get("email", "") or "").strip()
            password = str((payload or {}).get("password", "") or "")
            if email != self.server.login_email or password != self.server.login_password:
                self.record_failed_login(client_id)
                time.sleep(FAILED_LOGIN_DELAY_SECONDS)
                raise PermissionError("Email 或密碼不正確。")
            self.clear_failed_login(client_id)
            token = secrets.token_urlsafe(32)
            expires_at = int(time.time()) + int(self.server.session_ttl_seconds)
            user = bridge_user_payload(self.server.login_email, self.server.user_id)
            self.server.sessions[token] = {
                "user": user,
                "expiresAt": expires_at,
            }
            return {
                "token": token,
                "expiresAt": expires_at,
                "user": user,
            }
        if path == "/session/logout" and method == "POST":
            token = self.read_bearer_token()
            if token:
                self.server.sessions.pop(token, None)
            return {"ok": True}
        if path == "/session/me" and method == "GET":
            session = self.require_session()
            return {
                "user": session["user"],
                "expiresAt": session["expiresAt"],
            }

        conn = connect_sqlite(self.server.db_path)
        try:
            if self.server.login_email and self.server.login_password:
                self.require_session()
            user_id = self.server.user_id
            if path == "/settings/state" and method == "GET":
                return load_settings(conn, user_id)
            if path == "/settings/replace" and method == "POST":
                ensure_settings_row(conn, user_id)
                body = payload or {}
                conn.execute(
                    """
                    UPDATE user_settings
                    SET monthly_budget = ?, recurring_applied_month = ?, snapshot_dirty_from_month = ?,
                        legacy_transactions_checked_at = ?, updated_at = unixepoch()
                    WHERE user_id = ?
                    """,
                    (
                        int(body.get("monthlyBudget", 0) or 0),
                        str(body.get("recurringAppliedMonth", "") or ""),
                        str(body.get("snapshotDirtyFromMonth", "") or ""),
                        int(body.get("legacyTransactionsCheckedAt", 0) or 0),
                        user_id,
                    ),
                )
                conn.commit()
                return {"ok": True}
            if path == "/settings/patch" and method == "PATCH":
                ensure_settings_row(conn, user_id)
                current = load_settings(conn, user_id)
                body = {**current, **(payload or {})}
                conn.execute(
                    """
                    UPDATE user_settings
                    SET monthly_budget = ?, recurring_applied_month = ?, snapshot_dirty_from_month = ?,
                        legacy_transactions_checked_at = ?, updated_at = unixepoch()
                    WHERE user_id = ?
                    """,
                    (
                        int(body.get("monthlyBudget", 0) or 0),
                        str(body.get("recurringAppliedMonth", "") or ""),
                        str(body.get("snapshotDirtyFromMonth", "") or ""),
                        int(body.get("legacyTransactionsCheckedAt", 0) or 0),
                        user_id,
                    ),
                )
                conn.commit()
                return {"ok": True}
            if path == "/reference-data" and method == "GET":
                return {
                    "accounts": load_accounts(conn, user_id),
                    "categories": load_categories(conn, user_id),
                    "recurring": load_recurring(conn, user_id),
                }
            if path == "/common-summaries" and method == "GET":
                return load_common_summaries(conn, user_id)
            if path == "/common-summaries" and method == "POST":
                replace_common_summaries(conn, user_id, payload or {})
                conn.commit()
                return {"ok": True}
            if path == "/history-metadata" and method == "GET":
                return load_history_metadata(conn, user_id)
            if path == "/admin/status" and method == "GET":
                return sqlite_bridge_status(conn, user_id, self.server.db_path)
            if path == "/admin/rebuild-snapshots" and method == "POST":
                summary = rebuild_monthly_snapshots(conn, user_id, str((payload or {}).get("fromMonth", "") or ""))
                conn.commit()
                return {
                    "ok": True,
                    "fromMonth": summary["from_month"],
                    "toMonth": summary["to_month"],
                    "snapshotCount": len(summary["snapshots"]),
                    "transactionCount": summary["transaction_count"],
                }
            if path == "/transactions" and method == "GET":
                return load_transactions(
                    conn,
                    user_id,
                    str(query.get("startDate", [""])[0] or ""),
                    str(query.get("endDate", [""])[0] or ""),
                )
            if path.startswith("/snapshots/") and method == "GET":
                suffix = path[len("/snapshots/") :]
                if suffix.startswith("latest-before/"):
                    return load_latest_snapshot_before(conn, user_id, suffix[len("latest-before/") :])
                return load_snapshot_by_month(conn, user_id, suffix)
            if path.startswith("/collection/"):
                parts = [part for part in path.split("/") if part]
                name = parts[1]
                if method == "GET" and len(parts) == 2:
                    if name == "accounts":
                        return load_accounts(conn, user_id)
                    if name == "categories":
                        return load_categories(conn, user_id)
                    if name == "recurring":
                        return load_recurring(conn, user_id)
                    if name == "transactions":
                        return load_transactions(conn, user_id)
                    raise ValueError(f"不支援的集合：{name}")
                if method == "POST" and len(parts) == 2:
                    prefix = {
                        "accounts": "acc",
                        "categories": "cat",
                        "recurring": "rec",
                        "transactions": "txn",
                    }.get(name, "doc")
                    doc_id = str(payload.get("id", "") or "") or next_id(prefix)
                    self.upsert_collection(conn, user_id, name, doc_id, payload or {}, partial=False)
                    conn.commit()
                    return {"id": doc_id}
                if len(parts) == 3:
                    doc_id = parts[2]
                    if method == "PUT":
                        self.upsert_collection(conn, user_id, name, doc_id, payload or {}, partial=False)
                        conn.commit()
                        return {"ok": True}
                    if method == "PATCH":
                        self.upsert_collection(conn, user_id, name, doc_id, payload or {}, partial=True)
                        conn.commit()
                        return {"ok": True}
                    if method == "DELETE":
                        table = {
                            "accounts": "accounts",
                            "categories": "categories",
                            "recurring": "recurring_entries",
                            "transactions": "transactions",
                        }.get(name)
                        if not table:
                            raise ValueError(f"不支援的集合：{name}")
                        conn.execute(f"DELETE FROM {table} WHERE user_id = ? AND id = ?", (user_id, doc_id))
                        conn.commit()
                        return {"ok": True}
            if path == "/batch-update-orders" and method == "POST":
                for item in payload.get("items", []):
                    table = "accounts" if item.get("collection") == "accounts" else "categories"
                    conn.execute(
                        f"UPDATE {table} SET order_index = ?, updated_at = unixepoch() WHERE user_id = ? AND id = ?",
                        (int(item.get("order", 0) or 0), user_id, str(item.get("id", "") or "")),
                    )
                conn.commit()
                return {"ok": True}
            raise ValueError(f"不支援的路徑：{method} {path}")
        finally:
            conn.close()

    def upsert_collection(self, conn, user_id: str, name: str, doc_id: str, payload: dict, partial: bool):
        if name == "accounts":
            return upsert_account(conn, user_id, doc_id, payload, partial)
        if name == "categories":
            return upsert_category(conn, user_id, doc_id, payload, partial)
        if name == "recurring":
            return upsert_recurring(conn, user_id, doc_id, payload, partial)
        if name == "transactions":
            return upsert_transaction(conn, user_id, doc_id, payload, partial)
        raise ValueError(f"不支援的集合：{name}")

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def read_bearer_token(self) -> str:
        auth_header = str(self.headers.get("Authorization", "") or "").strip()
        if not auth_header.lower().startswith("bearer "):
            return ""
        return auth_header[7:].strip()

    def require_session(self) -> dict:
        token = self.read_bearer_token()
        now = int(time.time())
        expired_tokens = [key for key, value in self.server.sessions.items() if int(value.get("expiresAt", 0) or 0) <= now]
        for expired_token in expired_tokens:
            self.server.sessions.pop(expired_token, None)
        session = self.server.sessions.get(token)
        if not session:
            raise PermissionError("需要先登入。")
        return session

    def write_json(self, status: HTTPStatus, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")

    def send_security_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")

    def get_client_identifier(self) -> str:
        forwarded_for = str(self.headers.get("X-Forwarded-For", "") or "").strip()
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
        return str(self.client_address[0] if self.client_address else "unknown")

    def ensure_login_allowed(self, client_id: str):
        if not client_id:
            return
        entry = self.server.failed_login_attempts.get(client_id)
        if not entry:
            return
        now = int(time.time())
        locked_until = int(entry.get("lockedUntil", 0) or 0)
        if locked_until > now:
            raise PermissionError("登入失敗次數過多，請稍後再試。")
        if locked_until:
            self.server.failed_login_attempts.pop(client_id, None)

    def record_failed_login(self, client_id: str):
        if not client_id:
            return
        now = int(time.time())
        entry = self.server.failed_login_attempts.get(client_id) or {"attempts": [], "lockedUntil": 0}
        recent_attempts = [
            int(timestamp)
            for timestamp in entry.get("attempts", [])
            if now - int(timestamp) <= FAILED_LOGIN_WINDOW_SECONDS
        ]
        recent_attempts.append(now)
        locked_until = int(entry.get("lockedUntil", 0) or 0)
        if len(recent_attempts) >= FAILED_LOGIN_MAX_ATTEMPTS:
            locked_until = now + FAILED_LOGIN_LOCKOUT_SECONDS
        self.server.failed_login_attempts[client_id] = {
            "attempts": recent_attempts,
            "lockedUntil": locked_until,
        }

    def clear_failed_login(self, client_id: str):
        if not client_id:
            return
        self.server.failed_login_attempts.pop(client_id, None)

    def log_message(self, format: str, *args):
        return


def main() -> int:
    args = parse_args()
    db_path = Path(args.db).expanduser().resolve()
    if not db_path.exists():
        raise FileNotFoundError(f"找不到資料庫：{db_path}")

    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    server.db_path = db_path
    server.user_id = args.user_id
    server.login_email = str(args.login_email or "").strip()
    server.login_password = str(args.login_password or "")
    server.session_ttl_seconds = int(args.session_ttl_seconds or 43200)
    server.sessions = {}
    server.failed_login_attempts = {}
    print(f"SQLite bridge listening on http://{args.host}:{args.port} user_id={args.user_id} db={db_path}")
    if server.login_email and server.login_password:
        print(f"SQLite bridge login enabled for {server.login_email}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
