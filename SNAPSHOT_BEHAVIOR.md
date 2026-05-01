# Snapshot Behavior

這份文件專門說明 SQLite `monthly_snapshots` 何時會：

- 直接被重建並改寫數值
- 只被標記為 dirty，等之後再重建

## 背景

SQLite 版本把 snapshot 狀態拆成兩層：

- `monthly_snapshots`
  已經寫進資料庫的月結資料
- `user_settings.snapshot_dirty_from_month`
  表示從哪一個月份開始，既有 snapshot 已不可信

前端在讀 snapshot 時，會把 `snapshot_dirty_from_month` 之後的月份視為不可用，改用交易資料即時計算；但這不代表資料庫內的 `monthly_snapshots` 已經被同步改寫。

## 總結對照表

| 操作 | 會標 dirty | 會直接 rebuild | 備註 |
| --- | --- | --- | --- |
| `npm run sqlite:import-csv -- ...` | 否 | 是 | 匯入後直接重建全部 SQLite snapshots |
| `npm run sqlite:rebuild-snapshots -- ... --apply` | 否 | 是 | 直接重建並覆寫 `monthly_snapshots` |
| UI 按「重建 snapshots」 | 否 | 是 | 經由 bridge admin API 重建 |
| `npm run sqlite:import-firestore -- ...` | 否 | 否 | 匯入 Firestore 既有 snapshot，不是重算 |
| UI 新增交易 | 是 | 否 | 標記交易月份為 dirty |
| UI 編輯交易 | 是 | 否 | 標記舊月份與新月份中較早者為 dirty |
| UI 刪除交易 | 是 | 否 | 標記該交易月份為 dirty |
| UI 桌面列表批次編輯交易 | 是 | 否 | 標記整批變更涉及的最早月份 |
| UI 套用 recurring 產生當月交易 | 是 | 否 | 標記當月為 dirty |
| UI 修改帳戶期初餘額 | 是 | 否 | 只在 balance 變動時標 dirty |
| UI 修改 category 名稱 / 次序 | 否 | 否 | 不影響 snapshot 數值 |
| UI 新增帳戶 / category | 否 | 否 | 不直接影響既有 snapshot 數值 |
| CLI `sqlite:import-items` 且變更帳戶期初餘額 | 是 | 否 | 會更新 `snapshot_dirty_from_month` |
| 直接改 SQLite DB | 否 | 否 | 系統不會自動知道，要自己重建 |
| 直接打 bridge API 改交易 / 設定 | 視呼叫內容 | 否 | bridge 本身不會自動幫你標 dirty，通常靠前端做 |

## 會直接 rebuild 的操作

### 1. `sqlite:import-csv`

路徑：

- [scripts/import-to-sqlite.py](scripts/import-to-sqlite.py)
- [scripts/rebuild-sqlite-snapshots.py](scripts/rebuild-sqlite-snapshots.py)

這條流程在匯入項目與交易後，會直接呼叫 snapshot builder，然後整段覆寫 `monthly_snapshots`。

### 2. `sqlite:rebuild-snapshots --apply`

路徑：

- [scripts/rebuild-sqlite-snapshots.py](scripts/rebuild-sqlite-snapshots.py)

這是最直接的重建方式。執行後會：

1. 依 `--from-month` 或 `snapshot_dirty_from_month` 決定重建起點
2. 重算 snapshot
3. 寫回 `monthly_snapshots`
4. 清空 `snapshot_dirty_from_month`

### 3. UI 管理功能的 rebuild snapshots

路徑：

- [app.js](app.js)
- [data/sqlite-data-backend.js](data/sqlite-data-backend.js)
- [scripts/sqlite-http-bridge.py](scripts/sqlite-http-bridge.py)

這條是從前端按下「重建 snapshots」按鈕後，走 bridge admin API 重建。

### 4. `sqlite:import-firestore`

路徑：

- [scripts/export-firestore-to-sqlite.py](scripts/export-firestore-to-sqlite.py)

這條會把 Firestore 現有的 `monthlySnapshots` 匯進 SQLite，但不是「重新計算」。
所以它會改到 SQLite 內的 snapshot 數值，但來源是 Firestore 舊資料，不是 SQLite 即時計算結果。

## 只會標 dirty，不會直接 rebuild 的操作

### 1. UI 新增 / 編輯 / 刪除交易

路徑：

- [app.js](app.js)

對應行為：

- 新增 / 編輯交易後，呼叫 `markSnapshotDirtyFromMonth(...)`
- 刪除交易後，呼叫 `markSnapshotDirtyFromMonth(monthKey(transaction.date))`
- 桌面列表批次編輯也會標記最早受影響月份

這些操作只會更新 `snapshotDirtyFromMonth`，不會立刻改寫 `monthly_snapshots`。

### 2. UI 套用 recurring

路徑：

- [app.js](app.js)

系統若自動為當月產生 recurring 交易，會把當月標為 dirty，但不會立即重建 snapshot。

### 3. UI 修改帳戶期初餘額

路徑：

- [app.js](app.js)

只有帳戶 `balance` 真的改變時，才會標記 dirty。它會把該帳戶最早有交易的月份，或整體最早交易月份，設成 dirty 起點。

### 4. CLI `sqlite:import-items`

路徑：

- [scripts/import-items-to-sqlite.py](scripts/import-items-to-sqlite.py)

如果匯入項目 CSV 時改到帳戶期初餘額，會更新 `snapshot_dirty_from_month`，但不會自己重建 snapshot。

## 不會動到 snapshot 數值的常見操作

以下操作通常不會直接影響 snapshot 數值，因此也不會自動標 dirty：

- 修改 category 名稱
- 修改 category 次序
- 新增 category
- 新增帳戶但沒有調整既有交易與期初餘額
- 修改 `monthlyBudget`
- 修改 `common summaries`

注意：雖然這些不影響數值，但仍可能影響顯示名稱、排序或 UI 呈現。

## UI 修改歷史資料後，畫面會怎樣？

會發生兩件事：

1. 前端把 `snapshotDirtyFromMonth` 之後的 snapshot 視為不可用
2. 後續畫面改用交易資料即時計算

所以：

- 畫面上的數值通常會更新
- 但資料庫內的 `monthly_snapshots` 不會同步改寫

如果你要讓資料庫內保存的 snapshot 也一起更新，仍然要手動跑 rebuild。

## 什麼情況下建議手動 rebuild

建議在以下情況後手動重建：

- 改了歷史交易
- 刪了歷史交易
- 改了帳戶期初餘額
- 用外部腳本或 SQL 直接改 DB
- 要依賴 `monthly_snapshots` 做匯出、驗證或長期保存

## 最安全的操作建議

如果你做的是「會影響歷史月份數值」的修改，建議流程：

1. 先完成 UI 或 CLI 修改
2. 確認 `snapshotDirtyFromMonth` 已被標記
3. 執行：

```bash
npm run sqlite:rebuild-snapshots -- \
  --db "$DB" \
  --user-id local-user \
  --apply
```

4. 再執行：

```bash
npm run sqlite:verify-db -- --db "$DB" --user-id local-user
```
