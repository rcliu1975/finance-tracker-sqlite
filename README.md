# 家庭理財記帳 SQLite 版

這個 repo 是從 `finance-tracking` 拆出的 SQLite 主線版本。現在建議把資料放在本機 SQLite database，透過 CLI 匯入 / 匯出，並用 SQLite bridge 啟動 Web UI。

Firebase / Firestore 只保留相容與遷移路徑，相關說明見 [FIRESTORE_COMPAT.md](FIRESTORE_COMPAT.md)。

## 建議日常流程

以下以這幾個路徑為例，請換成你的實際檔名：

```bash
DB=~/finance-tracker.db
OLD_ITEMS=~/item_2025_UTF-8_import.csv
OLD_RECORDS=~/transactionP-2025_utf-8_import.csv
CONVERTED_DIR=./.tmp/converted-csv
EXAMPLE_DIR=./.tmp/example-csv
BACKUP_DIR=~/finance-tracker-backups
```

### 1. 把舊格式 CSV 轉成新格式

舊交易 CSV 是單一 `金額` 欄位；新版交易 CSV 使用 `從金額` / `至金額`，可支援外幣帳戶與換匯。

```bash
npm run sqlite:convert-legacy-csv -- \
  --legacy-items-csv "$OLD_ITEMS" \
  --legacy-transactions-csv "$OLD_RECORDS" \
  --output-dir "$CONVERTED_DIR" \
  --base-currency TWD
```

會產生：

- `$CONVERTED_DIR/items-foreign-currency-import.csv`
- `$CONVERTED_DIR/transactions-foreign-currency-import.csv`

轉換規則：

- 項目 CSV 新增 `幣別` 欄位。
- 帳戶列的 `幣別` 用 `--base-currency` 補值，預設 `TWD`。
- 分類列的 `幣別` 保持空白。
- 舊版交易 `金額` 會同時填入新版 `從金額` 與 `至金額`。

### 2. 產生新格式範例做比較

```bash
npm run sqlite:generate-fx-csv-examples -- \
  --output-dir "$EXAMPLE_DIR"
```

會產生：

- `$EXAMPLE_DIR/items-foreign-currency-example.csv`
- `$EXAMPLE_DIR/transactions-foreign-currency-example.csv`

建議用試算表或 diff 工具比較「範例檔」與「轉換後檔案」，確認欄位順序、幣別、`從金額` / `至金額` 都符合預期。

### 3. 匯入 SQLite database 並更新 snapshot

```bash
npm run sqlite:import-csv -- \
  --db "$DB" \
  --items-csv "$CONVERTED_DIR/items-foreign-currency-import.csv" \
  --transactions-csv "$CONVERTED_DIR/transactions-foreign-currency-import.csv" \
  --user-id local-user \
  --user-email you@example.com \
  --display-name "Local User" \
  --replace
```

`sqlite:import-csv` 會建立 / 更新 SQLite database，匯入項目與交易，並自動重建 `monthly_snapshots`。

匯入後建議驗證一次：

```bash
npm run sqlite:verify-db -- --db "$DB" --user-id local-user
```

注意：

- `--db` 建議放在 repo 外面，不要把私人 `.db` commit 進 repo。
- `--replace` 會覆蓋既有 database。
- 不使用 `--replace` 時，如果該 user 已有 transaction，匯入會拒絕，避免重複灌資料。

### 4. 給定 email / password 啟動 server

```bash
npm run sqlite:frontend -- \
  --db "$DB" \
  --user-id local-user \
  --login-email you@example.com \
  --login-password 'strong-password'
```

這個指令會：

1. 產生 `app-config.js`
2. 啟動 SQLite HTTP bridge
3. 啟動前端靜態 server

預設開啟：

- Frontend: `http://127.0.0.1:5173`
- SQLite bridge: `http://127.0.0.1:8765`

按 `Ctrl+C` 可同時停止 bridge 與前端 server。

若要讓同網段其他裝置連線：

```bash
npm run sqlite:frontend -- \
  --db "$DB" \
  --user-id local-user \
  --bridge-host 0.0.0.0 \
  --serve-host 0.0.0.0 \
  --open-host 192.168.1.10 \
  --login-email you@example.com \
  --login-password 'strong-password'
```

`--open-host` 要填其他裝置能連到這台機器的 IP 或 hostname。

### 5. 登入 UI 開始使用

打開前端網址後，用剛才設定的 email / password 登入。

SQLite bridge 登入是本機 bridge 的保護層，不是前端自助註冊。資料仍歸屬於 `--user-id` 指定的 SQLite user。

### 6. 必要時更新 snapshot

如果你手動改過 database、調整項目期初餘額，或覺得月結數字需要重算：

```bash
npm run sqlite:rebuild-snapshots -- \
  --db "$DB" \
  --user-id local-user \
  --apply
```

也可以指定起始月份：

```bash
npm run sqlite:rebuild-snapshots -- \
  --db "$DB" \
  --user-id local-user \
  --from-month 2024-01 \
  --apply
```

重建後再驗證：

```bash
npm run sqlite:verify-db -- --db "$DB" --user-id local-user
```

### 7. 經常匯出 CSV 備份

建議定期匯出項目與交易 CSV，放在 repo 外的備份目錄：

```bash
mkdir -p "$BACKUP_DIR"

npm run sqlite:export-items -- \
  --db "$DB" \
  --user-id local-user \
  --output "$BACKUP_DIR/items-$(date +%Y%m%d).csv"

npm run sqlite:export-records -- \
  --db "$DB" \
  --user-id local-user \
  --output "$BACKUP_DIR/records-$(date +%Y%m%d).csv"
```

如果需要桌面側欄月份矩陣：

```bash
npm run sqlite:export-sidebar-matrix -- \
  --db "$DB" \
  --user-id local-user \
  --output "$BACKUP_DIR/sidebar-matrix-$(date +%Y%m%d).csv"
```

## CSV 格式

### 項目 CSV

新版項目 CSV 欄位：

```csv
類別,項目名稱,幣別,期初餘額,次序,保護項目,ID,常用摘要
```

說明：

- `類別` 可用：`資產`、`負債`、`收入`、`支出`、`業外收入`、`業外支出`
- `幣別` 只用在 `資產` / `負債` 帳戶列，例如 `TWD`、`USD`
- 分類列的 `幣別` 留空
- `常用摘要` 可用 `；` 分隔多筆

### 交易 CSV

新版交易 CSV 欄位：

```csv
日期,從項目,從金額,至項目,至金額,摘要,備註
```

說明：

- 本幣交易通常 `從金額` 與 `至金額` 相同。
- 換匯或外幣帳戶交易可不同，例如台幣帳戶轉美元帳戶。
- `從項目` / `至項目` 必須對應項目 CSV 內的項目名稱。
- 系統會依項目位置與類別計算收支與餘額，不依賴交易類型欄位。

舊格式：

```csv
日期,從項目,至項目,金額,摘要,備註
```

舊格式請先用 `sqlite:convert-legacy-csv` 轉成新版格式後再匯入。

## 常用 CLI

| 指令 | 用途 |
| --- | --- |
| `npm run sqlite:convert-legacy-csv -- ...` | 舊版項目 / 交易 CSV 轉新版外幣格式 |
| `npm run sqlite:generate-fx-csv-examples -- ...` | 產生新版 CSV 範例 |
| `npm run sqlite:import-csv -- ...` | 匯入項目與交易 CSV 到 SQLite |
| `npm run sqlite:import-items -- ...` | 只匯入項目設定到既有 SQLite |
| `npm run sqlite:verify-db -- ...` | 驗證 SQLite 筆數、外鍵與月結摘要 |
| `npm run sqlite:rebuild-snapshots -- ...` | 重建 `monthly_snapshots` |
| `npm run sqlite:frontend -- ...` | 產生設定、啟動 bridge、啟動 Web UI |
| `npm run sqlite:bridge -- ...` | 只啟動 SQLite HTTP bridge |
| `npm run sqlite:export-items -- ...` | 匯出項目 CSV |
| `npm run sqlite:export-records -- ...` | 匯出交易 CSV |
| `npm run sqlite:export-sidebar-matrix -- ...` | 匯出桌面側欄月份矩陣 |
| `npm run sqlite:export-json -- ...` | 匯出前端 seed JSON，主要給測試 fallback 用 |

查參數：

```bash
npm run sqlite:import-csv -- --help
npm run sqlite:frontend -- --help
npm run sqlite:export-records -- --help
```

## SQLite bridge 安全注意

`sqlite:frontend` 會自動把前端來源加入 bridge 的 CORS allow-list。

如果你手動分開啟動 bridge 與前端，必須明確指定 `--cors-origin`：

```bash
npm run sqlite:bridge -- \
  --db "$DB" \
  --user-id local-user \
  --cors-origin http://127.0.0.1:5173 \
  --login-email you@example.com \
  --login-password 'strong-password'
```

bridge 對 browser request 會檢查 Origin；寫入 request body 必須使用 `Content-Type: application/json`。

## 專案檔案

- [app.js](app.js): 前端資料流程、互動與畫面渲染
- [index.html](index.html): 主要頁面
- [styles.css](styles.css): 視覺樣式
- [sqlite/schema.sql](sqlite/schema.sql): SQLite schema
- [scripts/import-to-sqlite.py](scripts/import-to-sqlite.py): 統一 SQLite 匯入入口
- [scripts/run-sqlite-frontend.py](scripts/run-sqlite-frontend.py): 一鍵啟動 SQLite bridge + Web UI
- [scripts/sqlite-http-bridge.py](scripts/sqlite-http-bridge.py): SQLite HTTP bridge
- [scripts/rebuild-sqlite-snapshots.py](scripts/rebuild-sqlite-snapshots.py): 重建月快照
- [scripts/verify-sqlite-db.py](scripts/verify-sqlite-db.py): 驗證 SQLite database
- [FIRESTORE_COMPAT.md](FIRESTORE_COMPAT.md): Firebase / Firestore 相容流程

## 補充文件

- [SQLITE_QUICKSTART.md](SQLITE_QUICKSTART.md): SQLite 快速啟動筆記
- [sqlite/README.md](sqlite/README.md): SQLite schema 與資料對照
- [sqlite/firestore-mapping.md](sqlite/firestore-mapping.md): Firestore 到 SQLite 對照
