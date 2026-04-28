from __future__ import annotations

import csv
import sqlite3
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path


ITEM_TYPE_MAP = {
    "資產": "asset",
    "負債": "liability",
    "收入": "income",
    "支出": "expense",
    "業外收入": "nonOperatingIncome",
    "業外支出": "nonOperatingExpense",
}

PROTECTED_ITEMS = {
    ("accounts", "asset", "現金"),
    ("accounts", "liability", "應付帳款"),
    ("categories", "income", "薪資收入"),
    ("categories", "expense", "餐飲費"),
}

TABLES = [
    "users",
    "user_settings",
    "accounts",
    "categories",
    "common_summaries",
    "transactions",
    "recurring_entries",
    "monthly_snapshots",
]


@dataclass
class ItemRef:
    collection: str
    item_type: str
    item_id: str
    name: str


def repo_root_from_script(script_file: str) -> Path:
    return Path(script_file).resolve().parent.parent


def load_schema(schema_path: Path) -> str:
    return schema_path.read_text(encoding="utf-8")


def normalize_header(value: str) -> str:
    return str(value or "").strip()


def parse_int(value: str, field_name: str, *, allow_blank: bool = False, default: int = 0) -> int:
    text = str(value or "").strip()
    if not text:
        if allow_blank:
            return default
        raise ValueError(f"{field_name} 不可空白")
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(f"{field_name} 不是有效數字：{text}") from exc
    if number != number.to_integral_value():
        raise ValueError(f"{field_name} 必須是整數：{text}")
    return int(number)


def normalize_date(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        raise ValueError("日期不可空白")
    raw = raw.replace("-", "/")
    parts = raw.split("/")
    if len(parts) != 3:
        raise ValueError(f"無法解析日期：{raw}")
    year, month, day = parts
    if len(year) != 4:
        raise ValueError(f"年份格式錯誤：{raw}")
    return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"


def next_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [{normalize_header(key): (value or "") for key, value in row.items()} for row in reader]


def connect_sqlite(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def prepare_database(db_path: Path, schema_sql: str, replace: bool) -> sqlite3.Connection:
    if db_path.exists():
        if not replace:
            raise FileExistsError(f"資料庫已存在：{db_path}")
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = connect_sqlite(db_path)
    connection.executescript(schema_sql)
    return connection


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
