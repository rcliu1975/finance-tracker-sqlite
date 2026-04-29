#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import locale
from pathlib import Path

from sqlite_migration_lib import connect_sqlite, list_months


GROUPS = [
    ("asset", "資產", "account"),
    ("liability", "負債", "account"),
    ("income", "收入", "category"),
    ("expense", "支出", "category"),
    ("nonOperatingIncome", "業外收入", "category"),
    ("nonOperatingExpense", "業外支出", "category"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a desktop-sidebar ordered monthly balance matrix from a SQLite finance database to CSV."
    )
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--output", required=True, help="Output CSV file path.")
    parser.add_argument("--user-id", default="", help="Optional user id override. Defaults to the first user in the database.")
    parser.add_argument("--start-month", default="2009-08", help="Start month in YYYY-MM format. Default: 2009-08")
    parser.add_argument("--end-month", default="", help="Optional end month in YYYY-MM format. Defaults to the latest snapshot month.")
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


def normalize_month(month_text: str, field_name: str) -> str:
    text = str(month_text or "").strip()
    if len(text) != 7 or text[4] != "-":
        raise SystemExit(f"{field_name} 格式錯誤：{text}，預期 YYYY-MM")
    try:
        year = int(text[:4])
        month = int(text[5:7])
    except ValueError as exc:
        raise SystemExit(f"{field_name} 格式錯誤：{text}，預期 YYYY-MM") from exc
    if month < 1 or month > 12:
        raise SystemExit(f"{field_name} 月份超出範圍：{text}")
    return f"{year:04d}-{month:02d}"


def month_label(month_text: str) -> str:
    year, month = month_text.split("-")
    return f"{int(year)}/{int(month)}"


def locale_sort_key(value: str) -> str:
    return locale.strxfrm(str(value or ""))


def sort_order(items: list[dict]) -> list[dict]:
    return sorted(
        items,
        key=lambda item: (
            -int(item.get("is_protected", 0) or 0),
            int(item.get("order_index", 100) or 100),
            locale_sort_key(str(item.get("name") or "")),
        ),
    )


def load_accounts(conn, user_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, name, type, order_index, is_protected
        FROM accounts
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchall()
    return [
        {
            "id": str(row["id"] or ""),
            "name": str(row["name"] or ""),
            "type": str(row["type"] or ""),
            "order_index": int(row["order_index"] or 0),
            "is_protected": int(row["is_protected"] or 0),
        }
        for row in rows
    ]


def load_categories(conn, user_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, name, type, order_index, is_protected
        FROM categories
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchall()
    return [
        {
            "id": str(row["id"] or ""),
            "name": str(row["name"] or ""),
            "type": str(row["type"] or ""),
            "order_index": int(row["order_index"] or 0),
            "is_protected": int(row["is_protected"] or 0),
        }
        for row in rows
    ]


def load_monthly_snapshots(conn, user_id: str) -> dict[str, dict]:
    rows = conn.execute(
        """
        SELECT month, closing_balances_json, income_total, expense_total, category_totals_json, net_worth
        FROM monthly_snapshots
        WHERE user_id = ?
        ORDER BY month ASC
        """,
        (user_id,),
    ).fetchall()
    snapshots = {}
    for row in rows:
        snapshots[str(row["month"] or "")] = {
            "closing_balances": json.loads(str(row["closing_balances_json"] or "{}")),
            "income_total": int(row["income_total"] or 0),
            "expense_total": int(row["expense_total"] or 0),
            "category_totals": json.loads(str(row["category_totals_json"] or "{}")),
            "net_worth": int(row["net_worth"] or 0),
        }
    return snapshots


def get_month_range(snapshot_map: dict[str, dict], start_month: str, end_month: str) -> list[str]:
    if not snapshot_map:
        raise SystemExit("資料庫內沒有 monthly_snapshots 資料。")
    effective_start = normalize_month(start_month, "--start-month")
    effective_end = normalize_month(end_month, "--end-month") if end_month else max(snapshot_map.keys())
    if effective_start > effective_end:
        raise SystemExit(f"月份範圍錯誤：{effective_start} > {effective_end}")
    return list_months(effective_start, effective_end)


def build_rows(accounts: list[dict], categories: list[dict]) -> list[dict]:
    rows = [
        {
            "group_key": "netWorth",
            "group_label": "總覽",
            "row_type": "summary",
            "name": "總資產負債結餘",
            "id": "",
            "value_getter": lambda snapshot: snapshot["net_worth"],
        }
    ]

    accounts_by_type = {group_key: sort_order([item for item in accounts if item["type"] == group_key]) for group_key, _, _ in GROUPS}
    categories_by_type = {
        group_key: sort_order([item for item in categories if item["type"] == group_key]) for group_key, _, _ in GROUPS
    }

    for group_key, group_label, collection_kind in GROUPS:
        if collection_kind == "account":
            group_items = accounts_by_type[group_key]
            rows.append(
                {
                    "group_key": group_key,
                    "group_label": group_label,
                    "row_type": "group",
                    "name": group_label,
                    "id": "",
                    "value_getter": lambda snapshot, item_type=group_key: sum(
                        int(snapshot["closing_balances"].get(item["id"], 0) or 0)
                        for item in accounts_by_type[item_type]
                    ),
                }
            )
            for item in group_items:
                rows.append(
                    {
                        "group_key": group_key,
                        "group_label": group_label,
                        "row_type": "account",
                        "name": item["name"],
                        "id": item["id"],
                        "value_getter": lambda snapshot, item_id=item["id"]: int(snapshot["closing_balances"].get(item_id, 0) or 0),
                    }
                )
            continue

        group_items = categories_by_type[group_key]
        if group_key == "income":
            getter = lambda snapshot: snapshot["income_total"]
        elif group_key == "expense":
            getter = lambda snapshot: snapshot["expense_total"]
        else:
            getter = lambda snapshot, item_type=group_key: sum(
                int(snapshot["category_totals"].get(item["id"], 0) or 0)
                for item in categories_by_type[item_type]
            )

        rows.append(
            {
                "group_key": group_key,
                "group_label": group_label,
                "row_type": "group",
                "name": group_label,
                "id": "",
                "value_getter": getter,
            }
        )
        for item in group_items:
            rows.append(
                {
                    "group_key": group_key,
                    "group_label": group_label,
                    "row_type": "category",
                    "name": item["name"],
                    "id": item["id"],
                    "value_getter": lambda snapshot, item_id=item["id"]: int(snapshot["category_totals"].get(item_id, 0) or 0),
                }
            )

    return rows


def export_rows(row_definitions: list[dict], month_range: list[str], snapshot_map: dict[str, dict]) -> list[list[str]]:
    header = ["順序", "群組", "列類型", "名稱", "ID", *[month_label(month) for month in month_range]]
    rows = [header]
    for index, row_def in enumerate(row_definitions, start=1):
        values = []
        for month in month_range:
            snapshot = snapshot_map.get(month)
            if not snapshot:
                values.append("")
                continue
            values.append(str(int(row_def["value_getter"](snapshot) or 0)))
        rows.append(
            [
                str(index),
                str(row_def["group_label"] or ""),
                str(row_def["row_type"] or ""),
                str(row_def["name"] or ""),
                str(row_def["id"] or ""),
                *values,
            ]
        )
    return rows


def main() -> None:
    try:
        locale.setlocale(locale.LC_COLLATE, "zh_TW.UTF-8")
    except locale.Error:
        try:
            locale.setlocale(locale.LC_COLLATE, "C.UTF-8")
        except locale.Error:
            pass

    args = parse_args()
    db_path = Path(args.db).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    conn = connect_sqlite(db_path)
    try:
        user_id = read_user_id(conn, args.user_id)
        accounts = load_accounts(conn, user_id)
        categories = load_categories(conn, user_id)
        snapshot_map = load_monthly_snapshots(conn, user_id)
        month_range = get_month_range(snapshot_map, args.start_month, args.end_month)
        row_definitions = build_rows(accounts, categories)
        rows = export_rows(row_definitions, month_range, snapshot_map)
    finally:
        conn.close()

    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(rows)
    print(f"已匯出 {output_path}")


if __name__ == "__main__":
    main()
