#!/usr/bin/env python3
"""
Rebuild monthly snapshots inside the SQLite migration database.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild monthly snapshots for the SQLite database.")
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--user-id", default="local-user", help="Target user id.")
    parser.add_argument("--from-month", default="", help="Optional YYYY-MM lower bound.")
    parser.add_argument("--apply", action="store_true", help="Persist rebuilt snapshots.")
    return parser.parse_args()


def month_key(date_text: str) -> str:
    return str(date_text or "")[:7]


def is_income_category_type(item_type: str) -> bool:
    return item_type in {"income", "nonOperatingIncome"}


def is_expense_category_type(item_type: str) -> bool:
    return item_type in {"expense", "nonOperatingExpense"}


def get_category_flow_type(item_type: str) -> str:
    if is_income_category_type(item_type):
        return "income"
    if is_expense_category_type(item_type):
        return "expense"
    return item_type


def infer_transaction_type(from_type: str, to_type: str) -> str:
    route_type_map = {
        "asset": {
            "asset": "transfer",
            "liability": "payment",
            "expense": "expense",
        },
        "liability": {
            "asset": "advance",
            "liability": "transfer",
            "expense": "expense",
        },
        "expense": {
            "asset": "refund",
            "liability": "refund",
        },
        "income": {
            "asset": "income",
            "liability": "payment",
            "expense": "expense",
        },
    }
    return route_type_map.get(get_category_flow_type(from_type), {}).get(get_category_flow_type(to_type), "transfer")


def list_months(from_month: str, to_month: str) -> list[str]:
    months = []
    year, month = map(int, from_month.split("-"))
    end_year, end_month = map(int, to_month.split("-"))
    while (year, month) <= (end_year, end_month):
        months.append(f"{year:04d}-{month:02d}")
        month += 1
        if month > 12:
            year += 1
            month = 1
    return months


def load_items(connection: sqlite3.Connection, user_id: str) -> tuple[list[dict], list[dict]]:
    accounts = [
        dict(row)
        for row in connection.execute(
            """
            SELECT id, name, type, opening_balance
            FROM accounts
            WHERE user_id = ?
            ORDER BY order_index, created_at, id
            """,
            (user_id,),
        )
    ]
    categories = [
        dict(row)
        for row in connection.execute(
            """
            SELECT id, name, type
            FROM categories
            WHERE user_id = ?
            ORDER BY order_index, created_at, id
            """,
            (user_id,),
        )
    ]
    return accounts, categories


def load_transactions(connection: sqlite3.Connection, user_id: str, accounts_by_id: dict, categories_by_id: dict) -> list[dict]:
    rows = connection.execute(
        """
        SELECT id, txn_date, from_kind, from_id, to_kind, to_id, amount, note, memo
        FROM transactions
        WHERE user_id = ?
        ORDER BY txn_date, id
        """,
        (user_id,),
    ).fetchall()
    result = []
    for row in rows:
        row = dict(row)
        row["date"] = row.pop("txn_date")
        row["fromItem"] = resolve_item(row.pop("from_kind"), row.pop("from_id"), accounts_by_id, categories_by_id)
        row["toItem"] = resolve_item(row.pop("to_kind"), row.pop("to_id"), accounts_by_id, categories_by_id)
        result.append(row)
    return result


def resolve_item(kind: str, item_id: str, accounts_by_id: dict, categories_by_id: dict) -> dict:
    if kind == "account":
        account = accounts_by_id.get(item_id, {})
        return {
            "kind": "account",
            "id": item_id,
            "name": account.get("name", ""),
            "type": account.get("type", ""),
        }
    category = categories_by_id.get(item_id, {})
    return {
        "kind": "category",
        "id": item_id,
        "name": category.get("name", ""),
        "type": category.get("type", ""),
    }


def apply_transaction_to_balances(balances: dict[str, int], transaction: dict) -> None:
    amount = int(transaction["amount"] or 0)
    txn_type = infer_transaction_type(transaction["fromItem"]["type"], transaction["toItem"]["type"])
    from_item = transaction["fromItem"]
    to_item = transaction["toItem"]

    if txn_type == "expense" and from_item["kind"] == "account":
        balances[from_item["id"]] = balances.get(from_item["id"], 0) + (amount if from_item["type"] == "liability" else -amount)
    if txn_type == "income" and to_item["kind"] == "account":
        balances[to_item["id"]] = balances.get(to_item["id"], 0) + amount
    if txn_type == "refund" and to_item["kind"] == "account":
        balances[to_item["id"]] = balances.get(to_item["id"], 0) + (-amount if to_item["type"] == "liability" else amount)
    if txn_type == "payment":
        if from_item["kind"] == "account":
            balances[from_item["id"]] = balances.get(from_item["id"], 0) - amount
        if to_item["kind"] == "account":
            balances[to_item["id"]] = balances.get(to_item["id"], 0) - amount
    if txn_type == "advance":
        if from_item["kind"] == "account":
            balances[from_item["id"]] = balances.get(from_item["id"], 0) + amount
        if to_item["kind"] == "account":
            balances[to_item["id"]] = balances.get(to_item["id"], 0) + amount
    if txn_type == "transfer":
        if from_item["kind"] == "account":
            balances[from_item["id"]] = balances.get(from_item["id"], 0) - amount
        if to_item["kind"] == "account":
            balances[to_item["id"]] = balances.get(to_item["id"], 0) + amount


def build_snapshots(accounts: list[dict], transactions: list[dict], requested_from_month: str, dirty_from_month: str) -> dict:
    months = sorted({month_key(transaction["date"]) for transaction in transactions if month_key(transaction["date"])})
    if not months:
        return {"from_month": "", "to_month": "", "snapshots": [], "transaction_count": 0}

    candidate_months = [value for value in [requested_from_month.strip(), dirty_from_month.strip(), months[0]] if value]
    from_month = sorted(candidate_months)[0]
    to_month = months[-1]
    target_months = list_months(from_month, to_month)
    balances = {account["id"]: int(account.get("opening_balance") or 0) for account in accounts}
    snapshots = []
    pointer = 0

    for month in target_months:
        category_totals: dict[str, int] = {}
        income_total = 0
        expense_total = 0
        source_last_transaction_date = ""

        while pointer < len(transactions) and month_key(transactions[pointer]["date"]) < month:
            apply_transaction_to_balances(balances, transactions[pointer])
            pointer += 1

        while pointer < len(transactions) and month_key(transactions[pointer]["date"]) == month:
            transaction = transactions[pointer]
            amount = int(transaction["amount"] or 0)
            txn_type = infer_transaction_type(transaction["fromItem"]["type"], transaction["toItem"]["type"])
            apply_transaction_to_balances(balances, transaction)

            if txn_type == "income":
                income_total += amount
                if transaction["fromItem"]["kind"] == "category" and transaction["fromItem"]["id"]:
                    category_totals[transaction["fromItem"]["id"]] = category_totals.get(transaction["fromItem"]["id"], 0) + amount
            elif txn_type == "expense":
                expense_total += amount
                if transaction["toItem"]["kind"] == "category" and transaction["toItem"]["id"]:
                    category_totals[transaction["toItem"]["id"]] = category_totals.get(transaction["toItem"]["id"], 0) + amount
            elif txn_type == "refund":
                expense_total -= amount
                if transaction["fromItem"]["kind"] == "category" and transaction["fromItem"]["id"]:
                    category_totals[transaction["fromItem"]["id"]] = category_totals.get(transaction["fromItem"]["id"], 0) - amount

            source_last_transaction_date = transaction["date"] or source_last_transaction_date
            pointer += 1

        closing_balances = {account["id"]: int(balances.get(account["id"], 0)) for account in accounts}
        net_worth = 0
        for account in accounts:
            value = closing_balances[account["id"]]
            net_worth += -value if account["type"] == "liability" else value

        snapshots.append(
            {
                "month": month,
                "closing_balances": closing_balances,
                "income_total": income_total,
                "expense_total": expense_total,
                "category_totals": dict(sorted(category_totals.items())),
                "net_worth": net_worth,
                "transaction_count": sum(1 for transaction in transactions if month_key(transaction["date"]) == month),
                "source_last_transaction_date": source_last_transaction_date,
                "rebuilt_at": int(time.time()),
            }
        )

    return {
        "from_month": from_month,
        "to_month": to_month,
        "snapshots": snapshots,
        "transaction_count": len(transactions),
    }


def persist_snapshots(connection: sqlite3.Connection, user_id: str, snapshots: list[dict]) -> None:
    connection.executemany(
        """
        INSERT INTO monthly_snapshots (
          user_id, month, closing_balances_json, income_total, expense_total,
          category_totals_json, net_worth, transaction_count, source_last_transaction_date, rebuilt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, month) DO UPDATE SET
          closing_balances_json = excluded.closing_balances_json,
          income_total = excluded.income_total,
          expense_total = excluded.expense_total,
          category_totals_json = excluded.category_totals_json,
          net_worth = excluded.net_worth,
          transaction_count = excluded.transaction_count,
          source_last_transaction_date = excluded.source_last_transaction_date,
          rebuilt_at = excluded.rebuilt_at
        """,
        [
            (
                user_id,
                snapshot["month"],
                json.dumps(snapshot["closing_balances"], ensure_ascii=False, sort_keys=True),
                snapshot["income_total"],
                snapshot["expense_total"],
                json.dumps(snapshot["category_totals"], ensure_ascii=False, sort_keys=True),
                snapshot["net_worth"],
                snapshot["transaction_count"],
                snapshot["source_last_transaction_date"],
                snapshot["rebuilt_at"],
            )
            for snapshot in snapshots
        ],
    )
    connection.execute(
        """
        UPDATE user_settings
        SET snapshot_dirty_from_month = '', updated_at = unixepoch()
        WHERE user_id = ?
        """,
        (user_id,),
    )


def main() -> int:
    args = parse_args()
    db_path = Path(args.db).expanduser().resolve()
    if not db_path.exists():
        raise FileNotFoundError(f"找不到資料庫：{db_path}")

    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        settings = connection.execute(
            "SELECT snapshot_dirty_from_month FROM user_settings WHERE user_id = ?",
            (args.user_id,),
        ).fetchone()
        accounts, categories = load_items(connection, args.user_id)
        accounts_by_id = {item["id"]: item for item in accounts}
        categories_by_id = {item["id"]: item for item in categories}
        transactions = load_transactions(connection, args.user_id, accounts_by_id, categories_by_id)
        dirty_from_month = settings["snapshot_dirty_from_month"] if settings else ""

        summary = build_snapshots(accounts, transactions, args.from_month, dirty_from_month)

        print(f"DB: {db_path}")
        print(f"user_id: {args.user_id}")
        print(f"accounts: {len(accounts)}")
        print(f"categories: {len(categories)}")
        print(f"transactions: {summary['transaction_count']}")
        print(f"from_month: {summary['from_month'] or '-'}")
        print(f"to_month: {summary['to_month'] or '-'}")
        print(f"snapshot_count: {len(summary['snapshots'])}")

        if summary["snapshots"]:
            first = summary["snapshots"][0]
            last = summary["snapshots"][-1]
            print(f"first_snapshot: {first['month']} income={first['income_total']} expense={first['expense_total']} net_worth={first['net_worth']}")
            print(f"last_snapshot: {last['month']} income={last['income_total']} expense={last['expense_total']} net_worth={last['net_worth']}")

        if args.apply and summary["snapshots"]:
            persist_snapshots(connection, args.user_id, summary["snapshots"])
            connection.commit()
            print("status: applied")
        elif args.apply:
            print("status: nothing-to-apply")
        else:
            print("status: dry-run")
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
