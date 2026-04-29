## Active

### 1. SQLite 主線收尾

1. 決定 SQLite 主線是否正式保留 `user_id` 多使用者欄位，或改成單使用者本機資料庫
2. 繼續把剩餘 Firebase / Firestore 相容層往邊界收斂，避免主流程再依賴舊命名與舊路徑假設
3. 盤點 bridge / CLI / 前端設定檔，確認 SQLite-first 路徑已足夠獨立

### 2. 效能與前端更新範圍

1. 把 running balance 的重算範圍進一步限制在「前一快照之後 + 當月資料」
2. 檢查桌面版切換時 `refreshTransactionsForCurrentView()` 的查詢範圍，確認在 dirty month 很早時是否還能再縮
3. 補上 bootstrap / desktop mode switch 的分段 timing log，量化剩餘瓶頸
4. 減少桌面版 `innerHTML` 整塊重建，改成較小範圍更新
5. 優先處理桌面版 sidebar 結構更新與 transaction table body 更新
6. 評估桌面版選年後，背景載入該年度 `monthlySnapshots` 並做 year-level cache

### 3. 外幣帳戶設計

1. 決定帳戶是否新增 `currency`
2. 決定交易是否改成同時保存：
   - `from_amount`
   - `to_amount`
3. 決定是否保存：
   - `base_currency`
   - `base_value_from`
   - `base_value_to`
   - `fx_gain_loss`
4. 決定匯兌損益是獨立分類，或作為系統調整欄位
5. 決定 snapshot 是否要記：
   - 原幣餘額
   - 本位幣估值
   - 已實現匯損益
   - 未實現匯損益
6. 決定 CSV / CLI / bridge API 是否一併升級支援外幣欄位

### 4. 外幣帳戶會計口徑

1. 外幣帳戶餘額顯示：
   - 只顯示原幣
   - 或同時顯示本位幣估值
2. 總資產 / 淨值估值口徑：
   - 使用月底匯率
   - 使用交易匯率
   - 或另建估值匯率表
3. 匯差認列口徑：
   - 換匯當下認列已實現損益
   - 月底評價認列未實現損益
4. 若開始做外幣，需同步定義驗帳公式與報表口徑
