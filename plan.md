# 月快照與大資料量效能方案

## 目標

`finance-tracking` 在記錄量很大時，前端不應每次開頁都從最早記錄一路重算到目前月份。  
解法是導入「月快照（monthly snapshots）」與「dirty month」機制，讓 UI 只重算必要區間。

## 問題現況

- 目前前端會把 `transactions` 全部載入，再做多次排序、篩選、running balance 計算。
- 當記錄量到數萬筆時：
  - 總覽變慢
  - 桌面版側欄變慢
  - 列表逐列餘額變慢
  - 圖表重算變慢

## 核心方向

### 1. 新增 `monthlySnapshots`

在 Firestore 新增：

- `users/{uid}/monthlySnapshots/{YYYY-MM}`

每份文件代表某一個月份結束後的快照。

建議欄位：

```json
{
  "month": "2025-04",
  "closingBalances": {
    "accountIdA": 12345,
    "accountIdB": -6000
  },
  "incomeTotal": 80000,
  "expenseTotal": 42000,
  "categoryTotals": {
    "categoryIdA": 12000,
    "categoryIdB": 8000
  },
  "netWorth": 350000,
  "rebuiltAt": 1777210000000,
  "sourceLastTransactionDate": "2025-04-30"
}
```

說明：

- `closingBalances`：月底時每個帳戶的餘額
- `incomeTotal`：該月收入總額
- `expenseTotal`：該月支出總額，退款已扣回
- `categoryTotals`：該月分類彙總
- `netWorth`：月底淨值

### 2. 新增 dirty month

在：

- `users/{uid}/meta/settings`

加入欄位：

```json
{
  "snapshotDirtyFromMonth": "2025-04"
}
```

規則：

- 若沒有 dirty，欄位可空白或不存在
- 只要有會影響歷史結果的變更，就把它設成「需要重建的最早月份」
- 若原本 dirty 是 `2025-04`，又改了 `2024-11`，則要更新成 `2024-11`

## 哪些操作要標記 dirty

以下任一情況都要更新 `snapshotDirtyFromMonth`：

1. 新增記錄
2. 編輯記錄
3. 刪除記錄
4. 修改資產 / 負債帳戶的期初餘額
5. 匯入記錄
6. 批次編輯記錄

dirty month 判定：

- 以受影響記錄的 `date` 所在月份為準
- 若是改帳戶期初餘額，建議直接標記為該帳戶最早記錄月份；若不好算，先標成全域最早月份也可接受

## CLI 工具

### 1. `scripts/rebuild-monthly-snapshots.js`

用途：

- 全量重建月快照
- 或從指定月份開始重建
- 支援 Emulator / Production
- 支援 `uid` / `email`

建議參數：

```bash
node scripts/rebuild-monthly-snapshots.js \
  --uid <uid> \
  --emulator \
  --from 2024-01 \
  --apply
```

必要功能：

- `--uid` 或 `--email`
- `--emulator` / `--production`
- `--from YYYY-MM`
- `--apply`
- 預設 dry-run

執行流程：

1. 讀取目標使用者所有帳戶、分類、記錄
2. 依日期升冪排序
3. 從起始月份往後月月累加
4. 寫入 `monthlySnapshots/{YYYY-MM}`
5. 若成功跑完，清掉 `snapshotDirtyFromMonth`

### 2. `scripts/verify-monthly-snapshots.js`

用途：

- 驗證快照是否和原始記錄一致
- 方便切換 UI 前先做一致性檢查

## UI 未來怎麼用

### 總覽

- 直接讀當月快照
- 不再每次從全部記錄重算

### 桌面版側欄

- 帳戶餘額：直接用快照的 `closingBalances`
- 月收入 / 支出 / 分類合計：直接用快照的 `incomeTotal`、`expenseTotal`、`categoryTotals`

### 記錄列表逐列餘額

不要從最早月份開始重播全部記錄。  
改成：

1. 先取前一個月快照
2. 以快照作為起始值
3. 只重算當月記錄

這樣逐列餘額仍正確，但運算量固定在「單月」。

## 前端與背景工作的責任分界

### 前端 UI 負責

- 寫入/修改/刪除記錄
- 標記 `snapshotDirtyFromMonth`

### 背景工作負責

- 依 dirty month 重建 `monthlySnapshots`

## 本機開發階段

先做：

1. `monthlySnapshots` 資料結構
2. `snapshotDirtyFromMonth`
3. `rebuild-monthly-snapshots.js`

這一階段先用 CLI 重建，不急著做自動背景重算。

## 部署到 Firebase 後

未來正式部署時可延伸成：

### 方案 A：Cloud Functions

- UI 寫入記錄後標記 dirty
- Functions 監看 `transactions` 或 `meta/settings`
- 自動從 dirty month 開始重建

適合：

- 自動化需求高
- 重建量中等

### 方案 B：Cloud Run

- UI 只標記 dirty
- Cloud Run job / Scheduler 定期處理

適合：

- 記錄量大
- 重建可能跨很多年
- 執行時間較長

## 實作順序

1. 寫 `rebuild-monthly-snapshots.js`
2. 在 UI 的新增/修改/刪除/匯入流程中補 `snapshotDirtyFromMonth`
3. 把桌面版餘額與總覽切到快照讀取
4. 再決定是否接 Cloud Functions 或 Cloud Run

## 取捨

優點：

- 大量資料下 UI 會明顯變快
- 讀取成本從「全歷史」降到「快照 + 當月」
- CLI 與未來 Firebase 後端方案可共用核心邏輯

代價：

- 資料模型變複雜
- 歷史資料改動後要維護 dirty month 與重建流程
- 需要額外驗證快照一致性
