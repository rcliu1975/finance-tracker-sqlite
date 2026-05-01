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
- 交易輸出會依 `日期` 由舊到新排序；同一天內保留原 CSV 的相對順序。

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

### 4. 給 Tailscale / Cloudflared 使用的啟動方式

如果只是本機使用，可以只綁在 `127.0.0.1`：

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

如果要透過 Tailscale、Cloudflared 或同網段其他裝置連 UI，前端 server 與 bridge 都要綁到外部位址，並用 `--open-host` 指定瀏覽器實際會連到的 hostname 或 IP：

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

`--open-host` 範例：

- Tailscale：`100.x.y.z` 或你的 tailnet hostname
- Cloudflared：對外公開的 hostname
- 區網：例如 `192.168.1.10`

這個 email / password 是 SQLite bridge 的 UI 登入保護，不是前端註冊帳號。對外開放前請使用強密碼，並優先放在 Tailscale 或 Cloudflared Access 這類額外保護後面。

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

## scripts 補充索引

日常操作優先使用 `npm run ...` wrapper；直接執行 `scripts/*` 主要用於除錯或需要繞過 npm 時。

### SQLite 日常腳本

| script | 建議指令 | 功能 | 基本用法 |
| --- | --- | --- | --- |
| `scripts/convert-legacy-import-csv.py` | `npm run sqlite:convert-legacy-csv -- ...` | 舊版項目 / 交易 CSV 轉新版外幣 CSV | `npm run sqlite:convert-legacy-csv -- --legacy-items-csv "$OLD_ITEMS" --legacy-transactions-csv "$OLD_RECORDS" --output-dir "$CONVERTED_DIR"` |
| `scripts/generate-foreign-currency-csv-examples.py` | `npm run sqlite:generate-fx-csv-examples -- ...` | 產生新版外幣 CSV 範例 | `npm run sqlite:generate-fx-csv-examples -- --output-dir "$EXAMPLE_DIR"` |
| `scripts/import-to-sqlite.py` | `npm run sqlite:import-csv -- ...` / `npm run sqlite:import-firestore -- ...` | 統一 SQLite 匯入入口，日常使用 `csv` 匯入完整項目與交易 | `npm run sqlite:import-csv -- --db "$DB" --items-csv items.csv --transactions-csv records.csv --replace` |
| `scripts/rebuild-sqlite-snapshots.py` | `npm run sqlite:rebuild-snapshots -- ...` | 重建 SQLite `monthly_snapshots` | `npm run sqlite:rebuild-snapshots -- --db "$DB" --user-id local-user --apply` |
| `scripts/verify-sqlite-db.py` | `npm run sqlite:verify-db -- ...` | 驗證 SQLite 筆數、外鍵與月結摘要 | `npm run sqlite:verify-db -- --db "$DB" --user-id local-user` |
| `scripts/run-sqlite-frontend.py` | `npm run sqlite:frontend -- ...` | 產生前端設定、啟動 bridge、啟動 Web UI | `npm run sqlite:frontend -- --db "$DB" --user-id local-user --login-email you@example.com --login-password 'strong-password'` |
| `scripts/sqlite-http-bridge.py` | `npm run sqlite:bridge -- ...` | 只啟動 SQLite HTTP bridge | `npm run sqlite:bridge -- --db "$DB" --user-id local-user --cors-origin http://127.0.0.1:5173 --login-email you@example.com --login-password 'strong-password'` |
| `scripts/export-items-from-sqlite.py` | `npm run sqlite:export-items -- ...` | 匯出項目 CSV | `npm run sqlite:export-items -- --db "$DB" --output items.csv` |
| `scripts/export-records-from-sqlite.py` | `npm run sqlite:export-records -- ...` | 匯出交易 CSV | `npm run sqlite:export-records -- --db "$DB" --output records.csv` |
| `scripts/export-desktop-sidebar-matrix.py` | `npm run sqlite:export-sidebar-matrix -- ...` | 匯出桌面側欄月份矩陣 CSV | `npm run sqlite:export-sidebar-matrix -- --db "$DB" --output sidebar-matrix.csv` |
| `scripts/export-sqlite-to-json.py` | `npm run sqlite:export-json -- ...` | 匯出前端 seed JSON，主要用於 fallback 測試 | `npm run sqlite:export-json -- --db "$DB" --output sqlite-seed.json` |

### SQLite 內部 helper

| script | 用途 | 使用建議 |
| --- | --- | --- |
| `scripts/import-csv-to-sqlite.py` | CSV 匯入的底層實作 | 建議改用 `npm run sqlite:import-csv -- ...` |
| `scripts/import-items-to-sqlite.py` | 只匯入項目設定的底層實作 | 日常流程不使用；保留給遷移除錯 |
| `scripts/export-firestore-to-sqlite.py` | Firestore 匯到 SQLite 的底層實作 | 建議改用 `npm run sqlite:import-firestore -- ...` |
| `scripts/sqlite_migration_lib.py` | SQLite 遷移共用函式庫 | 不直接執行 |

### 設定產生與本機 serve

| script / 指令 | 功能 | 基本用法 |
| --- | --- | --- |
| `scripts/generate-app-config.js` | 讀取 `.env` 產生 `app-config.js` | `npm run config:generate` |
| `scripts/generate-firebase-config.js` | 舊檔名相容 wrapper，產生 `firebase-config.js` | `node scripts/generate-firebase-config.js` |
| `npm run serve` | 先產生設定，再以 `python3 -m http.server` 開前端 | `npm run serve` |

### Firebase / Firestore 相容腳本

這些不是 SQLite 日常主線；只有需要維護舊 Firebase 資料或部署 Firebase Hosting 時才使用。

| script | 建議指令 | 功能 | 基本用法 |
| --- | --- | --- | --- |
| `scripts/import-records-cli.js` | `npm run import:records -- ...` | 將記錄 CSV 匯入 Firestore；預設 dry-run，`--apply` 才寫入 | `npm run import:records -- --csv records.csv --email you@example.com --production --apply` |
| `scripts/rebuild-monthly-snapshots.js` | `npm run rebuild:monthly-snapshots -- ...` | 重建 Firestore `monthlySnapshots`；預設 dry-run | `npm run rebuild:monthly-snapshots -- --email you@example.com --production --from 2024-01 --apply` |
| `scripts/cleanup-orphan-users.js` | `npm run cleanup:orphan-users` / `npm run cleanup:orphan-users:apply -- ...` | 找出 Auth 不存在但 Firestore 還存在的 `users/{uid}`；apply 模式會刪除 | `npm run cleanup:orphan-users:apply -- --confirm-project <projectId>` |
| `scripts/deploy.sh` | `scripts/deploy.sh` | Unix-like Firebase Hosting 部署檢查與部署 | `bash scripts/deploy.sh` |
| `scripts/deploy.ps1` | `scripts/deploy.ps1` | Windows PowerShell Firebase Hosting 部署檢查與部署 | `pwsh scripts/deploy.ps1` |

### npm Firebase 指令

| 指令 | 功能 |
| --- | --- |
| `npm run firebase:login` | 執行 Firebase CLI login |
| `npm run firebase:emulators` | 產生設定後啟動 Auth / Firestore Emulator |
| `npm run firebase:deploy` | 產生設定後部署 Firebase Hosting |
| `npm run firebase:deploy:rules` | 部署 Firestore rules |
