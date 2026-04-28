## SQLite Migration

1. 確認 SQLite 版是否保留 `user_id` 多使用者欄位，或改成單使用者本機資料庫
2. 寫 Firestore -> SQLite 匯出 / 轉檔腳本，至少能轉 `accounts`、`categories`、`transactions`、`recurring`、`monthlySnapshots`、`settings`
3. 抽出 data-access layer，先把 `app.js` 內 `collection/doc/getDocs/setDoc/updateDoc` 集中到單一模組
4. 先做 `read-only` 路徑切換，讓總覽、帳戶、分類、記錄列表可以從 SQLite 讀資料
5. 再補 `create/update/delete` 寫入路徑，最後移除前端對 Firestore SDK 的直接依賴
6. 決定認證策略：
   - 若是本機單人版，可移除 Firebase Auth
   - 若仍要多使用者同步，再另外定義同步層，不直接綁回 Firestore 文件結構

## P1

1. 拆 `loadAll()`，避免小變更也走全量 reload
2. 抽出 `loadSettingsState()`
3. 抽出 `loadReferenceData()`，只處理 `accounts` / `categories` / `recurring`
4. 抽出 `loadHistoryMetadata()`，只處理 `earliestTransactionMonth` / `earliestSnapshotMonth`
5. 抽出 `loadCurrentViewData()`，只處理目前畫面需要的 `transactions` / `snapshots`
6. 把交易新增 / 編輯 / 刪除改成局部 state 更新，避免每次 `await loadAll()`
7. 把 `earliestTransactionMonth` / `earliestSnapshotMonth` 做成 metadata
8. 新增/刪除最早那筆 transaction 時更新 `earliestTransactionMonth`
9. `rebuild-monthly-snapshots --apply` 完成時更新 `earliestSnapshotMonth`
10. 匯入 records 完成時一併更新兩個欄位
11. 讓桌面版更多路徑直接依賴 snapshot / metadata，而不是每次靠前端即時計算
12. 桌面版選年後，背景載入該年度的 `monthlySnapshots`，並做 year-level cache，提升同年切月速度

## P2

1. 先從三個熱點移除 `loadAll()` 依賴：
   - `saveEditedTransactions()`
   - `saveMobileItem()` / `saveDesktopSettingsItem()`
   - `applyRecurringIfNeeded()`
2. 把 running balance 的重算範圍進一步限制在「前一快照之後 + 當月資料」
3. 檢查桌面版切換時 `refreshTransactionsForCurrentView()` 的查詢範圍，確認在 dirty month 很早時是否還能再縮
4. 補上 bootstrap / desktop mode switch 的分段 timing log，量化剩餘瓶頸

## P3

1. 減少桌面版 `innerHTML` 整塊重建，改成較小範圍更新
2. 優先處理桌面版 sidebar 結構更新與 transaction table body 更新
