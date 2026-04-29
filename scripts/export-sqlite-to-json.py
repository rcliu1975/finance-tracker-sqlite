from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from sqlite_migration_lib import connect_sqlite


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export finance SQLite database to frontend seed JSON.")
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--output", required=True, help="Output JSON file path.")
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


def load_settings(conn, user_id: str) -> dict:
    row = conn.execute(
        """
        SELECT monthly_budget, recurring_applied_month, snapshot_dirty_from_month, legacy_transactions_checked_at
        FROM user_settings
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchone()
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


def load_accounts(conn, user_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, name, type, opening_balance, order_index, created_at, is_protected
        FROM accounts
        WHERE user_id = ?
        ORDER BY type ASC, order_index ASC, created_at ASC, id ASC
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


def load_categories(conn, user_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, name, type, order_index, created_at, is_protected
        FROM categories
        WHERE user_id = ?
        ORDER BY type ASC, order_index ASC, created_at ASC, id ASC
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


def build_item_ref(kind: str, item_id: str, accounts_by_id: dict, categories_by_id: dict) -> dict:
    if kind == "account":
        item = accounts_by_id.get(item_id)
    else:
        item = categories_by_id.get(item_id)
    return {
        "kind": kind,
        "id": item_id,
        "name": str((item or {}).get("name", "")),
        "type": str((item or {}).get("type", "")),
    }


def load_recurring(conn, user_id: str) -> list[dict]:
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


def load_transactions(conn, user_id: str, accounts_by_id: dict, categories_by_id: dict) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, txn_date, from_kind, from_id, to_kind, to_id, amount, note, memo, created_at
        FROM transactions
        WHERE user_id = ?
        ORDER BY txn_date DESC, created_at DESC, id DESC
        """,
        (user_id,),
    ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "date": str(row["txn_date"] or ""),
            "fromItem": build_item_ref(str(row["from_kind"] or ""), str(row["from_id"] or ""), accounts_by_id, categories_by_id),
            "toItem": build_item_ref(str(row["to_kind"] or ""), str(row["to_id"] or ""), accounts_by_id, categories_by_id),
            "amount": int(row["amount"] or 0),
            "note": str(row["note"] or ""),
            "memo": str(row["memo"] or ""),
            "createdAt": int(row["created_at"] or 0),
        }
        for row in rows
    ]


def load_monthly_snapshots(conn, user_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT month, closing_balances_json, income_total, expense_total, category_totals_json,
               net_worth, transaction_count, source_last_transaction_date, rebuilt_at
        FROM monthly_snapshots
        WHERE user_id = ?
        ORDER BY month ASC
        """,
        (user_id,),
    ).fetchall()
    return [
        {
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
        for row in rows
    ]


def load_common_summaries(conn, user_id: str) -> dict[str, list[str]]:
    rows = conn.execute(
        """
        SELECT scope_key, summary
        FROM common_summaries
        WHERE user_id = ?
        ORDER BY scope_key ASC, order_index ASC
        """,
        (user_id,),
    ).fetchall()
    grouped: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        grouped[str(row["scope_key"] or "")].append(str(row["summary"] or ""))
    return dict(grouped)


def main() -> None:
    args = parse_args()
    db_path = Path(args.db).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    conn = connect_sqlite(db_path)
    try:
        user_id = read_user_id(conn, args.user_id)
        settings = load_settings(conn, user_id)
        accounts = load_accounts(conn, user_id)
        categories = load_categories(conn, user_id)
        accounts_by_id = {item["id"]: item for item in accounts}
        categories_by_id = {item["id"]: item for item in categories}
        payload = {
            "userId": user_id,
            "settings": settings,
            "collections": {
                "accounts": accounts,
                "categories": categories,
                "recurring": load_recurring(conn, user_id),
                "transactions": load_transactions(conn, user_id, accounts_by_id, categories_by_id),
                "monthlySnapshots": load_monthly_snapshots(conn, user_id),
            },
            "commonSummaries": load_common_summaries(conn, user_id),
        }
    finally:
        conn.close()

    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已匯出 {output_path}")


if __name__ == "__main__":
    main()
