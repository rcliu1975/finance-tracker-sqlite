## 已定方向

### 1. 外幣資料模型

1. 外幣屬性只放在 `accounts`，不放在 `categories`
2. `accounts` 新增 `currency`
3. `transactions` 改存 `from_amount` / `to_amount`
4. 這次 schema 調整不用考慮向下相容
5. 本幣交易 UI 仍可只顯示單一 `金額`，但資料層統一寫成 `from_amount` / `to_amount`
6. 涉及外幣帳戶的交易，新增 / 編輯時顯示 `從金額`、`至金額`
7. 匯入 / 匯出新格式統一使用 `從金額`、`至金額`

### 2. 外幣顯示與估值

1. 外幣帳戶餘額以帳戶原幣計算與顯示
2. `income_total`、`expense_total`、`category_totals` 一律以本位幣保存
3. `總資產負債餘額`、`總資產`、`總負債` 一律以本位幣估值計算
4. `monthly_snapshots` 需額外保存每個外幣帳戶的月底本位幣估值
5. 外幣估值口徑：用截至該月底最近一期歷史資產換匯匯率
6. 匯差目前只做估值用途，不納入正式損益欄位
7. 月驗帳口徑：`淨值變動 = 收入 - 支出 + 外幣估值變動`

### 3. 收支統計口徑

1. 收支與餘額統計不再依賴交易型別，改用項目所在位置與類別決定正負
2. 對稱規則：
   - 資產：`from = -`，`to = +`
   - 負債：`from = +`，`to = -`
   - 收入：`from = +`，`to = -`
   - 支出：`from = -`，`to = +`
3. 收入總額 / 支出總額只看分類項目的 signed contribution
4. 退款 / 退貨由 `支出類別出現在 from` 自然表達為負值

## 已完成工具整理

1. 外幣規劃 CSV 範例改成由 `sqlite:generate-fx-csv-examples` 動態產生，不再把 `examples/` 內容放進版控
2. 已新增 `sqlite:convert-legacy-csv`，可把舊版單一 `金額` 匯入 CSV 轉成外幣規劃中的新格式
3. README 已同步標明舊格式與新格式差異
4. `sqlite/schema.sql` 已切到 `accounts.currency`、`transactions.from_amount/to_amount`
5. SQLite import / export / verify / bridge 已切到新欄位，並保留必要的舊資料相容讀取
6. `monthly_snapshots` 已新增月底本位幣估值與匯率欄位，snapshot rebuild 已會寫入
7. 前端交易表單、列表、編輯流程已切到 `fromAmount` / `toAmount`
8. 桌面版 sidebar、總覽、圖表與矩陣匯出已切到 snapshot 本位幣估值口徑

## 待實作

### 1. 前端與報表

1. 規劃總資產報表如何同時呈現原幣餘額與本位幣估值

### 2. 效能與更新範圍

1. 把 running balance 的重算範圍進一步限制在「前一快照之後 + 當月資料」
2. 檢查桌面版切換時 `refreshTransactionsForCurrentView()` 的查詢範圍，確認在 dirty month 很早時是否還能再縮
3. 補上 bootstrap / desktop mode switch 的分段 timing log，量化剩餘瓶頸
4. 減少桌面版 `innerHTML` 整塊重建，改成較小範圍更新
5. 優先處理桌面版 sidebar 結構更新與 transaction table body 更新
6. 評估桌面版選年後，背景載入該年度 `monthlySnapshots` 並做 year-level cache

### 3. 安全

1. `sqlite-http-bridge` 已支援 `--cors-origin` allowlist；手動 `sqlite:bridge` 流程仍需維持明確設定
2. bridge session token 已改成瀏覽器 `sessionStorage`；若前端出現 XSS 仍可被讀取
3. 前端仍大量依賴 `innerHTML`，需逐步縮小高頻可寫區塊
