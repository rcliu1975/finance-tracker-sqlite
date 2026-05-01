#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from pathlib import Path


ITEM_HEADERS = ["類別", "項目名稱", "幣別", "期初餘額", "次序", "保護項目", "ID", "常用摘要"]
TRANSACTION_HEADERS = ["日期", "從項目", "從金額", "至項目", "至金額", "摘要", "備註"]


ITEM_ROWS = [
    ["資產", "台幣帳戶", "TWD", "150000", "10", "否", "acc_twd_cash", ""],
    ["資產", "美元帳戶", "USD", "2500", "20", "否", "acc_usd_cash", ""],
    ["負債", "國泰世華costco卡", "TWD", "12000", "10", "否", "acc_costco_card", ""],
    ["收入", "薪資收入", "", "", "10", "是", "cat_salary", ""],
    ["收入", "其它收入", "", "", "20", "否", "cat_other_income", "現金回饋；利息"],
    ["支出", "餐飲費", "", "", "10", "是", "cat_food", "午餐；晚餐"],
    ["支出", "旅遊費", "", "", "20", "否", "cat_travel", "機票；住宿"],
    ["業外收入", "利息", "", "", "30", "否", "cat_interest", ""],
    ["業外支出", "手續費", "", "", "30", "否", "cat_fee", ""],
]


TRANSACTION_ROWS = [
    ["2026-04-01", "薪資收入", "50000", "台幣帳戶", "50000", "四月薪資", ""],
    ["2026-04-02", "台幣帳戶", "1200", "餐飲費", "1200", "聚餐", ""],
    ["2026-04-03", "台幣帳戶", "32000", "美元帳戶", "1000", "換匯買美元", "最近換匯匯率 32.0"],
    ["2026-04-04", "其它收入", "319", "國泰世華costco卡", "319", "現金回饋", "收入直接沖減卡債"],
    ["2026-04-05", "旅遊費", "80", "美元帳戶", "80", "旅遊退款", "退回美元帳戶"],
    ["2026-04-06", "美元帳戶", "150", "旅遊費", "150", "海外旅館", "外幣帳戶直接支付"],
    ["2026-04-07", "美元帳戶", "1000", "台幣帳戶", "31500", "美元換回台幣", "最近換匯匯率 31.5"],
    ["2026-04-08", "台幣帳戶", "30", "手續費", "30", "匯費", "換匯手續費"],
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate reference CSV examples for the planned foreign-currency item and transaction formats."
    )
    parser.add_argument(
        "--output-dir",
        default="./.tmp/foreign-currency-csv-examples",
        help="Directory to write the example CSV files. Default: ./.tmp/foreign-currency-csv-examples",
    )
    return parser.parse_args()


def write_csv(path: Path, headers: list[str], rows: list[list[str]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        writer.writerows(rows)


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    items_path = output_dir / "items-foreign-currency-example.csv"
    transactions_path = output_dir / "transactions-foreign-currency-example.csv"

    write_csv(items_path, ITEM_HEADERS, ITEM_ROWS)
    write_csv(transactions_path, TRANSACTION_HEADERS, TRANSACTION_ROWS)

    print(f"已產生 {items_path}")
    print(f"已產生 {transactions_path}")


if __name__ == "__main__":
    main()
