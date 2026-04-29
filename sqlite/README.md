# SQLite 遷移骨架

這個目錄先放 `finance-tracker-sqlite` 的資料層骨架，目標是把目前 Firestore 的資料模型整理成可逐步落地的 SQLite 結構。

目前提供：

- `schema.sql`：SQLite 初版 schema
- `firestore-mapping.md`：目前 Firestore 欄位到 SQLite 欄位的對照
- `import-notes.md`：目前已確認的 CSV 匯入來源格式備註

## 設計原則

- 先保留現有前端資料語意，不在第一步就重寫 UI 邏輯。
- `monthlySnapshots`、`user_settings`、`recurring_entries` 直接保留，因為它們已經是現有行為的一部分。
- `fromItem` / `toItem` 在 SQLite 先拆成 `from_kind`、`from_id`、`to_kind`、`to_id`，避免繼續保存巢狀 JSON。
- `commonSummaries` 雖然目前只存在 `localStorage`，但 SQLite 版需要可同步與可備份，所以先納入 schema。

## Firestore 對 SQLite 對照

- `users/{uid}/accounts` -> `accounts`
- `users/{uid}/categories` -> `categories`
- `users/{uid}/transactions` -> `transactions`
- `users/{uid}/recurring` -> `recurring_entries`
- `users/{uid}/monthlySnapshots/{YYYY-MM}` -> `monthly_snapshots`
- `users/{uid}/meta/settings` -> `user_settings`
- `localStorage.financeCommonSummaries:v2` -> `common_summaries`

## 目前刻意保留的取捨

- `closing_balances_json` 與 `category_totals_json` 先保留 JSON 欄位，因為它們本質是每月彙總快照，不是交易明細。
- `transactions` 暫時不對 `from_id` / `to_id` 加外鍵，因為它們可能指向 `accounts` 或 `categories` 其中之一；等資料層抽象完成後再決定是否拆雙欄位或改成 ledger entries。
- `users` 先只保留最低限度欄位；認證機制之後可能不再沿用 Firebase Auth。

## 下一步

1. 確認 SQLite 版是否仍採單使用者模型，或要保留多使用者欄位。
2. 補一份 Firestore -> SQLite 匯出/轉檔腳本。
3. 抽出 repository/data-access layer，讓 `app.js` 不直接依賴 Firestore SDK。
