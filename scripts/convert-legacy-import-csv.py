#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from sqlite_migration_lib import ITEM_TYPE_MAP, normalize_header, read_csv_rows


LEGACY_ITEM_REQUIRED_HEADERS = ["類別", "項目名稱"]
LEGACY_TRANSACTION_REQUIRED_HEADERS = ["日期", "從項目", "至項目", "金額"]
NEW_ITEM_HEADERS = ["類別", "項目名稱", "幣別", "期初餘額", "次序", "保護項目", "ID", "常用摘要"]
NEW_TRANSACTION_HEADERS = ["日期", "從項目", "從金額", "至項目", "至金額", "摘要", "備註"]
ACCOUNT_TYPES = {"asset", "liability"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert legacy item / transaction CSV files into the planned foreign-currency CSV format."
    )
    parser.add_argument("--legacy-items-csv", required=True, help="Legacy items CSV path.")
    parser.add_argument("--legacy-transactions-csv", required=True, help="Legacy transactions CSV path.")
    parser.add_argument(
        "--output-dir",
        default="./.tmp/converted-foreign-currency-csv",
        help="Directory to write converted CSV files. Default: ./.tmp/converted-foreign-currency-csv",
    )
    parser.add_argument(
        "--base-currency",
        default="TWD",
        help="Currency code assigned to account rows converted from legacy items CSV. Default: TWD",
    )
    return parser.parse_args()


def validate_headers(rows: list[dict[str, str]], required_headers: list[str], file_label: str) -> None:
    if not rows:
        return
    row_headers = {normalize_header(key) for key in rows[0].keys()}
    missing = [header for header in required_headers if header not in row_headers]
    if missing:
        raise ValueError(f"{file_label} 缺少欄位：{', '.join(missing)}")


def convert_item_rows(rows: list[dict[str, str]], base_currency: str) -> list[list[str]]:
    output_rows: list[list[str]] = [NEW_ITEM_HEADERS]
    normalized_currency = normalize_header(base_currency).upper() or "TWD"
    for index, row in enumerate(rows, start=2):
        label = normalize_header(row.get("類別", ""))
        item_type = ITEM_TYPE_MAP.get(label)
        if not item_type:
            raise ValueError(f"items CSV 第 {index} 列類別無法辨識：{label}")
        currency = normalized_currency if item_type in ACCOUNT_TYPES else ""
        output_rows.append(
            [
                label,
                normalize_header(row.get("項目名稱", "")),
                currency,
                normalize_header(row.get("期初餘額", "")),
                normalize_header(row.get("次序", "")),
                normalize_header(row.get("保護項目", "")),
                normalize_header(row.get("ID", "")),
                normalize_header(row.get("常用摘要", "")),
            ]
        )
    return output_rows


def convert_transaction_rows(rows: list[dict[str, str]]) -> list[list[str]]:
    output_rows: list[list[str]] = [NEW_TRANSACTION_HEADERS]
    for row in rows:
        amount = normalize_header(row.get("金額", ""))
        output_rows.append(
            [
                normalize_header(row.get("日期", "")),
                normalize_header(row.get("從項目", "")),
                amount,
                normalize_header(row.get("至項目", "")),
                amount,
                normalize_header(row.get("摘要", "")),
                normalize_header(row.get("備註", "")),
            ]
        )
    return output_rows


def write_csv(path: Path, rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(rows)


def main() -> int:
    args = parse_args()
    legacy_items_path = Path(args.legacy_items_csv).expanduser().resolve()
    legacy_transactions_path = Path(args.legacy_transactions_csv).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not legacy_items_path.exists():
        raise FileNotFoundError(f"找不到舊 items CSV：{legacy_items_path}")
    if not legacy_transactions_path.exists():
        raise FileNotFoundError(f"找不到舊 transactions CSV：{legacy_transactions_path}")

    item_rows = read_csv_rows(legacy_items_path)
    transaction_rows = read_csv_rows(legacy_transactions_path)
    validate_headers(item_rows, LEGACY_ITEM_REQUIRED_HEADERS, "舊 items CSV")
    validate_headers(transaction_rows, LEGACY_TRANSACTION_REQUIRED_HEADERS, "舊 transactions CSV")

    converted_item_rows = convert_item_rows(item_rows, args.base_currency)
    converted_transaction_rows = convert_transaction_rows(transaction_rows)

    items_output_path = output_dir / "items-foreign-currency-import.csv"
    transactions_output_path = output_dir / "transactions-foreign-currency-import.csv"
    write_csv(items_output_path, converted_item_rows)
    write_csv(transactions_output_path, converted_transaction_rows)

    print(f"已產生 {items_output_path}")
    print(f"已產生 {transactions_output_path}")
    print("說明：舊版單一 `金額` 已展開成新版 `從金額` / `至金額`；帳戶列 `幣別` 依 --base-currency 補值。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
