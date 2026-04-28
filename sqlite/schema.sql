PRAGMA foreign_keys = ON;

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  monthly_budget INTEGER NOT NULL DEFAULT 0,
  recurring_applied_month TEXT NOT NULL DEFAULT '',
  snapshot_dirty_from_month TEXT NOT NULL DEFAULT '',
  legacy_transactions_checked_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability')),
  opening_balance INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  is_protected INTEGER NOT NULL DEFAULT 0 CHECK (is_protected IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, type, name)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_type_order
  ON accounts(user_id, type, order_index, created_at);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'nonOperatingIncome', 'nonOperatingExpense')),
  order_index INTEGER NOT NULL DEFAULT 0,
  is_protected INTEGER NOT NULL DEFAULT 0 CHECK (is_protected IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, type, name)
);

CREATE INDEX IF NOT EXISTS idx_categories_user_type_order
  ON categories(user_id, type, order_index, created_at);

CREATE TABLE IF NOT EXISTS recurring_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_recurring_entries_user_day
  ON recurring_entries(user_id, day_of_month, created_at);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  txn_date TEXT NOT NULL,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('account', 'category')),
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('account', 'category')),
  to_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  note TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (length(txn_date) = 10)
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_date
  ON transactions(user_id, txn_date, created_at, id);

CREATE INDEX IF NOT EXISTS idx_transactions_user_from
  ON transactions(user_id, from_kind, from_id, txn_date);

CREATE INDEX IF NOT EXISTS idx_transactions_user_to
  ON transactions(user_id, to_kind, to_id, txn_date);

CREATE TABLE IF NOT EXISTS monthly_snapshots (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  closing_balances_json TEXT NOT NULL DEFAULT '{}',
  income_total INTEGER NOT NULL DEFAULT 0,
  expense_total INTEGER NOT NULL DEFAULT 0,
  category_totals_json TEXT NOT NULL DEFAULT '{}',
  net_worth INTEGER NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  source_last_transaction_date TEXT NOT NULL DEFAULT '',
  rebuilt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, month),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS common_summaries (
  user_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, scope_key, order_index),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_common_summaries_user_scope
  ON common_summaries(user_id, scope_key, order_index);

COMMIT;
