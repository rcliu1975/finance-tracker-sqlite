#!/usr/bin/env python3
"""
Rebuild monthly snapshots inside the SQLite migration database.
"""

from __future__ import annotations

import argparse
import sqlite3
import time
from pathlib import Path
import json
from decimal import Decimal, ROUND_HALF_UP

from sqlite_migration_lib import (
    connect_sqlite,
    has_column,
    list_months,
    month_key,
)


BASE_CURRENCY = "TWD"
OPERATING_INCOME_TYPES = {"income"}
OPERATING_EXPENSE_TYPES = {"expense"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild monthly snapshots for the SQLite database.")
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--user-id", default="local-user", help="Target user id.")
    parser.add_argument("--from-month", default="", help="Optional YYYY-MM lower bound.")
    parser.add_argument("--apply", action="store_true", help="Persist rebuilt snapshots.")
    return parser.parse_args()

def load_items(connection: sqlite3.Connection, user_id: str) -> tuple[list[dict], list[dict]]:
    account_has_currency = has_column(connection, "accounts", "currency")
    if account_has_currency:
        account_query = """
            SELECT id, name, type, currency, opening_balance
            FROM accounts
            WHERE user_id = ?
            ORDER BY order_index, created_at, id
            """
    else:
        account_query = """
            SELECT id, name, type, opening_balance
            FROM accounts
            WHERE user_id = ?
            ORDER BY order_index, created_at, id
            """
    accounts = [
        dict(row)
        for row in connection.execute(account_query, (user_id,))
    ]
    for item in accounts:
        item["currency"] = str(item.get("currency", BASE_CURRENCY) or BASE_CURRENCY).upper()
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
    dual_amounts = has_column(connection, "transactions", "from_amount") and has_column(connection, "transactions", "to_amount")
    if dual_amounts:
        rows = connection.execute(
            """
            SELECT id, txn_date, from_kind, from_id, to_kind, to_id, from_amount, to_amount, note, memo
            FROM transactions
            WHERE user_id = ?
            ORDER BY txn_date, id
            """,
            (user_id,),
        ).fetchall()
    else:
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
        if dual_amounts:
            row["fromAmount"] = int(row.pop("from_amount") or 0)
            row["toAmount"] = int(row.pop("to_amount") or 0)
            row["amount"] = row["toAmount"] if row["fromAmount"] != row["toAmount"] else row["fromAmount"]
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
            "currency": str(account.get("currency", BASE_CURRENCY) or BASE_CURRENCY).upper(),
        }
    category = categories_by_id.get(item_id, {})
    return {
        "kind": "category",
        "id": item_id,
        "name": category.get("name", ""),
        "type": category.get("type", ""),
        "currency": BASE_CURRENCY,
    }


def signed_item_delta(item: dict, side: str, amount: int) -> int:
    item_type = str(item.get("type", "") or "")
    if item_type in {"asset", "expense", "nonOperatingExpense"}:
        return -amount if side == "from" else amount
    if item_type in {"liability", "income", "nonOperatingIncome"}:
        return amount if side == "from" else -amount
    return 0


def apply_transaction_to_balances(balances: dict[str, int], transaction: dict) -> None:
    from_item = transaction["fromItem"]
    to_item = transaction["toItem"]
    if from_item["kind"] == "account" and from_item["id"]:
        from_amount = int(transaction.get("fromAmount", transaction.get("amount", 0)) or 0)
        balances[from_item["id"]] = balances.get(from_item["id"], 0) + signed_item_delta(from_item, "from", from_amount)
    if to_item["kind"] == "account" and to_item["id"]:
        to_amount = int(transaction.get("toAmount", transaction.get("amount", 0)) or 0)
        balances[to_item["id"]] = balances.get(to_item["id"], 0) + signed_item_delta(to_item, "to", to_amount)


def update_fx_rates(fx_rates: dict[str, Decimal], transaction: dict) -> None:
    from_item = transaction["fromItem"]
    to_item = transaction["toItem"]
    if from_item["kind"] != "account" or to_item["kind"] != "account":
        return
    from_currency = str(from_item.get("currency", BASE_CURRENCY) or BASE_CURRENCY).upper()
    to_currency = str(to_item.get("currency", BASE_CURRENCY) or BASE_CURRENCY).upper()
    if from_currency == to_currency:
        return
    from_amount = int(transaction.get("fromAmount", transaction.get("amount", 0)) or 0)
    to_amount = int(transaction.get("toAmount", transaction.get("amount", 0)) or 0)
    if from_amount <= 0 or to_amount <= 0:
        return
    if from_currency == BASE_CURRENCY and to_currency != BASE_CURRENCY:
        fx_rates[to_item["id"]] = Decimal(from_amount) / Decimal(to_amount)
    elif to_currency == BASE_CURRENCY and from_currency != BASE_CURRENCY:
        fx_rates[from_item["id"]] = Decimal(to_amount) / Decimal(from_amount)


def to_base_value(balance: int, currency: str, fx_rates: dict[str, Decimal], account_id: str) -> tuple[int, str]:
    normalized_currency = str(currency or BASE_CURRENCY).upper()
    if normalized_currency == BASE_CURRENCY:
        return int(balance), "1"
    rate = fx_rates.get(account_id)
    if rate is None:
        return 0, ""
    base_value = int((Decimal(balance) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return base_value, format(rate.normalize(), "f")


def category_totals_by_type(category_totals: dict[str, int], categories_by_id: dict[str, dict], allowed_types: set[str]) -> int:
    total = 0
    for category_id, amount in category_totals.items():
        category = categories_by_id.get(category_id, {})
        if str(category.get("type", "") or "") in allowed_types:
            total += int(amount or 0)
    return total


def build_snapshots(
    accounts: list[dict],
    categories: list[dict],
    transactions: list[dict],
    requested_from_month: str,
    dirty_from_month: str,
) -> dict:
    months = sorted({month_key(transaction["date"]) for transaction in transactions if month_key(transaction["date"])})
    if not months:
        return {"from_month": "", "to_month": "", "snapshots": [], "transaction_count": 0}

    candidate_months = [value for value in [requested_from_month.strip(), dirty_from_month.strip(), months[0]] if value]
    from_month = sorted(candidate_months)[0]
    to_month = months[-1]
    target_months = list_months(from_month, to_month)
    balances = {account["id"]: int(account.get("opening_balance") or 0) for account in accounts}
    categories_by_id = {item["id"]: item for item in categories}
    fx_rates: dict[str, Decimal] = {}
    snapshots = []
    pointer = 0

    for month in target_months:
        category_totals: dict[str, int] = {}
        source_last_transaction_date = ""
        month_transaction_count = 0

        while pointer < len(transactions) and month_key(transactions[pointer]["date"]) < month:
            apply_transaction_to_balances(balances, transactions[pointer])
            update_fx_rates(fx_rates, transactions[pointer])
            pointer += 1

        while pointer < len(transactions) and month_key(transactions[pointer]["date"]) == month:
            transaction = transactions[pointer]
            apply_transaction_to_balances(balances, transaction)
            update_fx_rates(fx_rates, transaction)
            for side, item in (("from", transaction["fromItem"]), ("to", transaction["toItem"])):
                if item["kind"] != "category" or not item["id"]:
                    continue
                amount = int(
                    transaction.get("fromAmount", transaction.get("amount", 0))
                    if side == "from"
                    else transaction.get("toAmount", transaction.get("amount", 0))
                )
                delta = signed_item_delta(item, side, amount)
                if not delta:
                    continue
                category_totals[item["id"]] = category_totals.get(item["id"], 0) + delta

            source_last_transaction_date = transaction["date"] or source_last_transaction_date
            month_transaction_count += 1
            pointer += 1

        income_total = category_totals_by_type(category_totals, categories_by_id, OPERATING_INCOME_TYPES)
        expense_total = category_totals_by_type(category_totals, categories_by_id, OPERATING_EXPENSE_TYPES)

        closing_balances = {account["id"]: int(balances.get(account["id"], 0)) for account in accounts}
        closing_base_values: dict[str, int] = {}
        closing_fx_rates: dict[str, str] = {}
        total_assets = 0
        total_liabilities = 0
        for account in accounts:
            value = closing_balances[account["id"]]
            base_value, rate_text = to_base_value(value, str(account.get("currency", BASE_CURRENCY) or BASE_CURRENCY), fx_rates, account["id"])
            closing_base_values[account["id"]] = base_value
            if rate_text:
                closing_fx_rates[account["id"]] = rate_text
            if account["type"] == "liability":
                total_liabilities += base_value
            else:
                total_assets += base_value
        net_worth = total_assets - total_liabilities

        snapshots.append(
            {
                "month": month,
                "closing_balances": closing_balances,
                "closing_base_values": closing_base_values,
                "closing_fx_rates": closing_fx_rates,
                "income_total": income_total,
                "expense_total": expense_total,
                "category_totals": dict(sorted(category_totals.items())),
                "net_worth": net_worth,
                "transaction_count": month_transaction_count,
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
          user_id, month, closing_balances_json, closing_base_values_json, closing_fx_rates_json,
          income_total, expense_total, category_totals_json, net_worth, transaction_count, source_last_transaction_date, rebuilt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, month) DO UPDATE SET
          closing_balances_json = excluded.closing_balances_json,
          closing_base_values_json = excluded.closing_base_values_json,
          closing_fx_rates_json = excluded.closing_fx_rates_json,
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
                json.dumps(snapshot["closing_base_values"], ensure_ascii=False, sort_keys=True),
                json.dumps(snapshot["closing_fx_rates"], ensure_ascii=False, sort_keys=True),
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

    connection = connect_sqlite(db_path)
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

        summary = build_snapshots(accounts, categories, transactions, args.from_month, dirty_from_month)

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
