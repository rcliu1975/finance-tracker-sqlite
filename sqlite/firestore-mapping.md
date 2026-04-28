# Firestore 到 SQLite 欄位對照

這份文件用來把現有前端實際讀寫的欄位，對照到 `sqlite/schema.sql`。

## `users/{uid}/accounts` -> `accounts`

Firestore 欄位：

- `id`
- `name`
- `balance`
- `type`
- `order`
- `createdAt`

SQLite 欄位：

- `id`
- `user_id`
- `name`
- `opening_balance`
  說明：沿用目前前端語意。現階段 `balance` 代表帳戶基準餘額，不是即時計算後餘額。
- `type`
- `order_index`
- `is_protected`
  說明：Firestore 沒有明存，現在由系統保護項目規則推導；SQLite 先實體化。
- `created_at`
- `updated_at`

## `users/{uid}/categories` -> `categories`

Firestore 欄位：

- `id`
- `name`
- `type`
- `order`
- `createdAt`

SQLite 欄位：

- `id`
- `user_id`
- `name`
- `type`
- `order_index`
- `is_protected`
- `created_at`
- `updated_at`

## `users/{uid}/transactions` -> `transactions`

Firestore 欄位：

- `id`
- `date`
- `fromItem.kind`
- `fromItem.id`
- `fromItem.name`
- `fromItem.type`
- `toItem.kind`
- `toItem.id`
- `toItem.name`
- `toItem.type`
- `amount`
- `note`
- `memo`

SQLite 欄位：

- `id`
- `user_id`
- `txn_date`
- `from_kind`
- `from_id`
- `to_kind`
- `to_id`
- `amount`
- `note`
- `memo`
- `created_at`
- `updated_at`

說明：

- `fromItem.name/type` 與 `toItem.name/type` 在前端主要是方便顯示與相容舊資料；SQLite 版先只保留 id + kind，名稱與類型由關聯表查出。
- 若未來要做更正規的 double-entry ledger，可再把 `transactions` 拆成 header + entries。

## `users/{uid}/recurring` -> `recurring_entries`

前端實際使用欄位：

- `id`
- `name`
- `accountId`
- `categoryId`
- `amount`
- `day`

SQLite 欄位：

- `id`
- `user_id`
- `name`
- `account_id`
- `category_id`
- `amount`
- `day_of_month`
- `created_at`
- `updated_at`

## `users/{uid}/monthlySnapshots/{YYYY-MM}` -> `monthly_snapshots`

前端 / CLI 使用欄位：

- `month`
- `closingBalances`
- `incomeTotal`
- `expenseTotal`
- `categoryTotals`
- `netWorth`
- `transactionCount`
- `sourceLastTransactionDate`
- `rebuiltAt`

SQLite 欄位：

- `user_id`
- `month`
- `closing_balances_json`
- `income_total`
- `expense_total`
- `category_totals_json`
- `net_worth`
- `transaction_count`
- `source_last_transaction_date`
- `rebuilt_at`

## `users/{uid}/meta/settings` -> `user_settings`

前端實際使用欄位：

- `monthlyBudget`
- `recurringAppliedMonth`
- `snapshotDirtyFromMonth`
- `legacyTransactionsCheckedAt`

SQLite 欄位：

- `user_id`
- `monthly_budget`
- `recurring_applied_month`
- `snapshot_dirty_from_month`
- `legacy_transactions_checked_at`
- `created_at`
- `updated_at`

## `localStorage.financeCommonSummaries:v2` -> `common_summaries`

目前結構：

- 以 `scopeKey` 為 key 的物件
- value 是最多 6 筆字串陣列

SQLite 欄位：

- `user_id`
- `scope_key`
- `order_index`
- `summary`
- `created_at`

## 尚未直接落表的資訊

- Firebase Auth 狀態與登入流程
- `.firebaserc` / project id 等部署環境資訊
- `desktopMode`、`desktopDate`、`transactionRange` 這類純 UI 狀態

這些資料不應直接進入核心交易資料表；若 SQLite 版需要保留，可另分成本機偏好設定表或設定檔。
