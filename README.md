# 家庭理財記帳

> 這個 repo 是從 `finance-tracking` 拆出的 `SQLite` 遷移專案。  
> 目前前端仍保留 Firebase / Firestore 相容路徑，但 SQLite 工具鏈與資料邊界已獨立整理在這個 repo；後續修改會持續往 SQLite 化收斂。

這是一個正在從 Firebase / Firestore 遷移到 SQLite 的前端記帳工具，適合用來管理家庭收支、固定支出與基礎財務分析。

## SQLite 遷移現況

- 已建立初版 SQLite schema：[sqlite/schema.sql](sqlite/schema.sql)
- 已整理 Firestore 對 SQLite 的資料對照：[sqlite/README.md](sqlite/README.md)
- 已有統一 SQLite 匯入入口：`scripts/import-to-sqlite.py`
- `sqlite:import-firestore`、`sqlite:import-csv`、`sqlite:import-items` 都已整合到同一支主程式
- 已有 SQLite 項目 CSV 匯出腳本：`scripts/export-items-from-sqlite.py`
- 已有 SQLite 記錄 CSV 匯出腳本：`scripts/export-records-from-sqlite.py`
- 已有 SQLite -> 前端 seed JSON 匯出腳本：`scripts/export-sqlite-to-json.py`
- 已有 SQLite 月快照重建腳本：`scripts/rebuild-sqlite-snapshots.py`
- 已有 SQLite 驗證腳本：`scripts/verify-sqlite-db.py`
- 已有 SQLite HTTP bridge：`scripts/sqlite-http-bridge.py`
- 前端已改成透過 `data/app-data-backend.js` 讀寫資料，為接上 SQLite backend 預留穩定介面
- 前端 runtime / auth 已改成透過 `data/app-runtime.js` 進入，減少 `app.js` 對 Firebase 專名的直接耦合
- 已加入 `APP_STORAGE_BACKEND=sqlite` provider 切換；目前可透過 `APP_SQLITE_API_BASE_URL` 直接連本機 SQLite bridge，`seed JSON + localStorage` 改為 fallback
- `commonSummaries` 在 SQLite bridge 模式下也會直接持久化到 SQLite，不再只靠瀏覽器 `localStorage`
- 線上項目匯入 / 匯出入口已移除，改走 `scripts/` 下的 command line 工具

### SQLite 匯入測試

如果你要直接把某個 Firebase / Firestore 使用者匯成 SQLite：

```bash
npm run sqlite:import-firestore -- \
  --db ~/finance-tracker-sqlite-test.db \
  --uid <uid> \
  --production \
  --replace
```

或用 email 查目標使用者：

```bash
npm run sqlite:import-firestore -- \
  --db ~/finance-tracker-sqlite-test.db \
  --email you@example.com \
  --emulator \
  --replace
```

這支工具目前會匯入：

- `accounts`
- `categories`
- `transactions`
- `recurring`
- `monthlySnapshots`
- `meta/settings`

如果你已經有既有的項目 / 交易 CSV，可以直接建立一個 SQLite 測試資料庫：

```bash
npm run sqlite:import-csv -- \
  --db ~/finance-tracker-sqlite-test.db \
  --items-csv ~/item_2025_UTF-8_import.csv \
  --transactions-csv ~/transactionP-2025_utf-8_import.csv \
  --replace
```

說明：

- 這只會讀取你指定的 CSV，不會把 CSV 放進 repo
- `--db` 建議指定在 repo 外部的位置
- `--replace` 會覆蓋既有資料庫檔
- 預設會建立單一使用者 `local-user`
- 匯入完成後會直接重建 `monthly_snapshots`
- 如果目標 `user` 已經有 transaction 記錄，匯入會直接拒絕，避免重複灌資料

匯入後可再做一次快速驗證：

```bash
npm run sqlite:verify-db -- --db ~/finance-tracker-sqlite-test.db
```

如果要重建 SQLite 版月快照：

```bash
npm run sqlite:rebuild-snapshots -- --db ~/finance-tracker-sqlite-test.db --apply
```

如果要把 SQLite 測試資料庫匯出成前端可直接載入的 seed JSON：

```bash
npm run sqlite:export-json -- \
  --db ~/finance-tracker-sqlite-test.db \
  --output /tmp/finance-tracker-sqlite-seed.json
```

建議依序執行：

1. `sqlite:import-csv`
2. `sqlite:rebuild-snapshots --apply`
3. `sqlite:verify-db`
4. `sqlite:export-json`

不要同時對同一顆 `.db` 平行執行 `--replace` 匯入、快照重建與驗證。

## Command line 項目匯入 / 匯出

前端已移除線上 `項目匯入` / `項目匯出`，改成只保留 command line 流程。

### 匯出 SQLite 項目 CSV

```bash
npm run sqlite:export-items -- \
  --db ~/finance-tracker-sqlite-test.db \
  --output ~/items-export.csv
```

說明：

- `--db`：來源 SQLite 資料庫
- `--output`：輸出的 CSV 檔案路徑
- `--user-id`：可選；未指定時取資料庫內第一個 user

匯出的欄位格式：

- `類別`
- `項目名稱`
- `期初餘額`
- `次序`
- `保護項目`
- `ID`
- `常用摘要`

### 匯入 SQLite 項目 CSV

```bash
npm run sqlite:import-items -- \
  --db ~/finance-tracker-sqlite-test.db \
  --items-csv ~/items-export.csv
```

說明：

- `--db`：目標 SQLite 資料庫
- `--items-csv`：要匯入的 CSV 檔案
- `--user-id`：可選；未指定時取資料庫內第一個 user

行為：

- 同名同類型項目會更新
- 新項目會新增到資料庫
- 類別項目的 `常用摘要` 會同步更新到 `common_summaries`
- 若有帳戶期初餘額變動，會更新 `user_settings.snapshot_dirty_from_month`
- 若目標 `user` 已經有 transaction 記錄，匯入會直接拒絕

## Command line 記錄匯出

前端已不提供線上記錄匯出；若需要 CSV，請直接從 SQLite 匯出。

```bash
npm run sqlite:export-records -- \
  --db ~/finance-tracker-sqlite-test.db \
  --output ~/records-export.csv
```

說明：

- `--db`：來源 SQLite 資料庫
- `--output`：輸出的 CSV 檔案路徑
- `--user-id`：可選；未指定時取資料庫內第一個 user

匯出的欄位格式：

- `日期`
- `從項目`
- `至項目`
- `金額`
- `摘要`
- `備註`

## 目前功能

- 記錄收入、支出與轉帳記錄
- 管理帳戶、分類與每月預算
- 記錄列表支援全部、1 星期、1 個月篩選
- 顯示總資產、本月收支與預算使用率
- 產生最近記錄列表、分類圓餅圖與近六個月收支圖
- 支援固定支出自動帶入當月記錄
- 支援桌面版模式：
  - 在寬度 `>= 1024px` 時顯示 `桌面版` 按鈕
  - 切換後會把 topbar 下方改成左側摘要欄 + 右側工作區的桌面版架構
  - 會記住桌面版開關、左側群組收合狀態與所選年月

## 專案檔案

- `index.html`: 主要頁面結構
- `styles.css`: 視覺樣式與 RWD
- `app.js`: Firebase 連線、資料處理與畫面渲染
- `.env.example`: 本機與部署用 Firebase / Emulator 設定範本
- `firebase-config.example.js`: Firebase 設定範本
- `firebase.json`: Firebase Hosting 設定
- `firestore.rules`: Firestore 權限規則，只允許登入者存取自己的 `users/{uid}` 資料
- `.firebaserc`: Firebase 專案綁定設定
- `scripts/deploy.sh`: Unix-like 環境部署腳本
- `scripts/deploy.ps1`: Windows PowerShell 部署腳本
- `scripts/cleanup-orphan-users.js`: 比對 Firebase Authentication 與 Firestore `users/{uid}`，清理不存在帳號的使用者資料
- `scripts/generate-firebase-config.js`: 依 `.env` 產生 `firebase-config.js`
- `scripts/import-records-cli.js`: 在 command line 下匯入記錄 CSV，支援 dry-run、Emulator 與正式 Firestore
- `scripts/import-to-sqlite.py`: 統一 SQLite 匯入主入口，支援 `firestore`、`csv`、`items` 三種來源
- `scripts/export-items-from-sqlite.py`: 從 SQLite 資料庫匯出項目 CSV
- `scripts/export-records-from-sqlite.py`: 從 SQLite 資料庫匯出記錄 CSV
- `scripts/rebuild-sqlite-snapshots.py`: 依 SQLite 交易資料重建 `monthly_snapshots`
- `scripts/verify-sqlite-db.py`: 驗證產生出的 SQLite 資料庫筆數與外鍵狀態
- `scripts/sqlite-http-bridge.py`: 提供前端直接讀寫 SQLite `.db` 的本機 HTTP bridge
- `scripts/rebuild-monthly-snapshots.js`: 重建 `monthlySnapshots`，支援 dirty month、Emulator 與正式 Firestore

## 目前介面模式

- 行動版：保留原本分頁式記帳介面
- 桌面版：
  - 左側顯示資產、負債、收入、支出四組摘要
  - 右側改成 design repo 風格的工作區，顯示所選年月的記錄資料
  - `新增記錄` 會使用桌面版專用小視窗，不影響行動版新增頁
  - `項目設定` 會使用桌面版專用小視窗，不影響行動版設定頁
  - 線上匯入 / 匯出入口已移除，改走 command line 工具

## 介面樣式分工

- 行動版專屬樣式使用 `body.mobile-mode` 作為作用範圍
- 桌面版專屬樣式使用 `body.desktop-mode` 作為作用範圍
- 共用元件樣式保留在未加模式前綴的規則中，避免兩種模式互相覆蓋

## 已移除功能

- 專案欄位
- 專案分頁
- 專案總覽與專案預算
- `projects` 相關資料流與 CSV 匯出欄位

## 本機啟動

### SQLite 模式

#### SQLite HTTP bridge 模式

如果你要讓前端直接讀寫某顆 SQLite `.db`，先啟動 bridge：

```bash
npm run sqlite:bridge -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user
```

然後在 `.env` 設：

```dotenv
APP_STORAGE_BACKEND=sqlite
APP_LOCAL_USER_ID=local-user
APP_SQLITE_API_BASE_URL=http://127.0.0.1:8765
APP_SQLITE_SEED_PATH=
```

再啟動前端：

```bash
npm run serve
```

這個模式目前特性如下：

- 前端會直接透過 HTTP bridge 讀寫 SQLite `.db`
- `commonSummaries` 也會直接寫回 SQLite
- 不走 Firebase Authentication
- 會以單一本機使用者進入 app
- 需要 bridge 行程持續運作

bridge 額外提供的管理 API：

- `GET /health`
- `GET /admin/status`
- `POST /admin/rebuild-snapshots`

範例：

```bash
curl http://127.0.0.1:8765/admin/status
curl -X POST http://127.0.0.1:8765/admin/rebuild-snapshots \
  -H 'Content-Type: application/json' \
  -d '{"fromMonth":"2024-01"}'
```

#### SQLite seed fallback 模式

如果你要先驗證前端在非 Firebase 路徑下能否啟動，可把 `.env` 設成：

```dotenv
APP_STORAGE_BACKEND=sqlite
APP_LOCAL_USER_ID=local-user
APP_SQLITE_SEED_PATH=/sqlite-seed.json
```

這個模式目前特性如下：

- 如果有設定 `APP_SQLITE_SEED_PATH`，啟動時會先抓取 seed JSON
- 成功載入後，後續修改會保存在目前瀏覽器的 `localStorage`
- 如果沒設定 `APP_SQLITE_SEED_PATH`，就退回空白的本機記憶體模式
- 不需要 Firebase Web App 金鑰
- 不走 Firebase Authentication
- 會以單一本機使用者進入 app
- 純記憶體模式下，重新整理頁面後資料不保留

最簡單的本機測試方式，是先把 seed JSON 放在專案根目錄，例如：

```bash
npm run sqlite:export-json -- \
  --db ~/finance-tracker-sqlite-test.db \
  --output ./sqlite-seed.json
```

然後在 `.env` 設：

```dotenv
APP_STORAGE_BACKEND=sqlite
APP_LOCAL_USER_ID=local-user
APP_SQLITE_SEED_PATH=/sqlite-seed.json
```

啟動方式仍然相同：

```bash
npm run serve
```

### Production 連線

1. 複製設定檔：

```bash
cp .env.example .env
```

2. 編輯 `.env`，填入你的 Firebase Web App 設定，並設定：

```dotenv
FIREBASE_USE_EMULATORS=false
```

3. 啟動靜態伺服器：

```bash
npm run serve
```

4. 開啟 `http://localhost:5173`

### Firebase Emulator

1. 複製設定檔：

```bash
cp .env.example .env
```

2. 編輯 `.env`，填入你的 Firebase Web App 設定，並設定：

```dotenv
FIREBASE_USE_EMULATORS=true
FIREBASE_EMULATOR_HOST=127.0.0.1
FIREBASE_AUTH_EMULATOR_PORT=9099
FIREBASE_FIRESTORE_EMULATOR_PORT=8080
FIREBASE_EMULATOR_UI_PORT=4000
```

如果要讓其他裝置透過 Tailscale 連入，`FIREBASE_EMULATOR_HOST` 請改成這台主機的 Tailscale IP 或可解析的主機名。

3. 啟動靜態伺服器：

```bash
npm run serve
```

4. 在另一個終端啟動 Emulator：

```bash
npm run firebase:emulators
```

這個指令現在會自動使用：

- 匯入資料目錄：`.firebase/emulator-data`
- 關閉時自動回存：`.firebase/emulator-data`

也就是說，只要你是用 `npm run firebase:emulators` 啟動，Emulator 的 Auth / Firestore 資料重開後會保留。

5. 可用網址：

- App: `http://localhost:5173`
- Firestore Emulator: `http://localhost:8080`
- Auth Emulator: `http://localhost:9099`
- Emulator UI: `http://localhost:4000`

如果經 Tailscale 連線，請把 `localhost` 換成主機的 Tailscale IP 或主機名。

## Firebase Hosting 部署

先確認：

- `.firebaserc` 已填入正確的 Firebase project id
- `.env` 已填入正確的 Firebase Web config
- `FIREBASE_USE_EMULATORS=false`
- 你已完成 `firebase login`

常用指令：

```bash
npm run config:generate
npm run firebase:login
npm run firebase:emulators
npm run firebase:deploy
npm run firebase:deploy:rules
npm run import:records -- --help
npm run rebuild:monthly-snapshots -- --help
npm run cleanup:orphan-users
npm run cleanup:orphan-users:apply
```

Windows PowerShell：

```powershell
./scripts/deploy.ps1
```

macOS / Linux / Git Bash：

```bash
./scripts/deploy.sh
```

部署完成後，Firebase CLI 會輸出 Hosting 網址。

## 孤兒使用者資料清理

如果 Firebase Authentication 已刪除某些帳號，但 Firestore `users/{uid}` 還留著資料，可用下列指令清理：

```bash
npm run cleanup:orphan-users
npm run cleanup:orphan-users:apply -- --confirm-project <projectId>
```

說明：

- `cleanup:orphan-users`：只列出不存在帳號但仍留在 Firestore 的 `users/{uid}`，不會真的刪除
- `cleanup:orphan-users:apply`：實際遞迴刪除那些 `users/{uid}` 及其子集合資料；現在必須再加 `--confirm-project <projectId>` 才會執行
- `--project <projectId>`：可覆寫 `.firebaserc` 的 default project id
- 需要先完成 `firebase login`

## Command line 匯入記錄

大量資料匯入時，建議直接用 command line。這支工具使用和既有資料模型一致的匯入語意：

- 支援 `,`、`;`、`Tab` 分隔
- 支援 `YYYY/MM/DD` 自動轉成 `YYYY-MM-DD`
- 會檢查項目是否存在、日期/金額格式是否正確
- 會依從項目與至項目自動判定 `收入`、`支出`、`支付`、`預借`、`退款`
- 預設是 `dry-run`，只有加 `--apply` 才會真的寫入

基本用法：

```bash
npm run import:records -- --csv ./records.csv --uid <uid> --emulator
npm run import:records -- --csv ./records.csv --email you@example.com --production
npm run import:records -- --csv ./records.csv --uid <uid> --production --apply
```

說明：

- `--csv`：CSV 檔案路徑
- `--uid`：直接指定匯入的 Firebase Auth `uid`
- `--email`：用 email 查出目標 `uid`
- `--emulator`：匯入到 Firebase Emulator
- `--production`：匯入到正式 Firestore
- `--apply`：真的寫入；沒加時只做檢查與統計

注意：

- `--uid` 或 `--email` 必填其一
- `--emulator` / `--production` 若都沒指定，會依 `.env` 的 `FIREBASE_USE_EMULATORS` 判定
- 用 `--email` 查正式 Firebase 時，需要先完成 `firebase login`

## Command line 重建月快照

這支工具會依 `accounts`、`categories`、`transactions` 重建：

- `users/{uid}/monthlySnapshots/{YYYY-MM}`

重點：

- 支援 `--uid` / `--email`
- 支援 `--emulator` / `--production`
- 支援 `--from YYYY-MM`
- 預設 `dry-run`
- 若沒指定 `--from`，會優先使用 `meta/settings.snapshotDirtyFromMonth`

基本用法：

```bash
npm run rebuild:monthly-snapshots -- --uid <uid> --emulator
npm run rebuild:monthly-snapshots -- --email you@example.com --production
npm run rebuild:monthly-snapshots -- --uid <uid> --production --from 2024-01 --apply
```

說明：

- `--apply`：真的寫入 `monthlySnapshots`，並清掉 `snapshotDirtyFromMonth`
- 沒加 `--apply`：只顯示會重建哪些月份
- 快照內容包含：
  - `closingBalances`
  - `incomeTotal`
  - `expenseTotal`
  - `categoryTotals`
  - `netWorth`
  - `rebuiltAt`
  - `sourceLastTransactionDate`

## Firebase Hosting 發佈內容

專案目前已整理成適合直接發佈到 Firebase Hosting：

- 會部署前端頁面、樣式、JavaScript 與 `firebase-config.js`
- 不會部署 `.git`、README、部署腳本、Firestore 規則、範例設定檔與本機測試輸出
- 已補上 `favicon.svg`，避免頁面出現 favicon 404

## 目前 Firebase 資料結構

- `users/{uid}/accounts`
  項目欄位包含：`name`、`balance`、`type`、`order`。
- `users/{uid}/categories`
  項目欄位包含：`name`、`type`、`order`。`type` 可為 `income`、`expense`、`nonOperatingIncome`、`nonOperatingExpense`。
- `users/{uid}/transactions`
  記錄文件只保留：`date`、`fromItem`、`toItem`、`amount`、`note`、`memo`
  `fromItem` / `toItem` 只儲存：`kind`、`id`；名稱與類型由前端即時從 `accounts` / `categories` 查詢。
- `users/{uid}/recurring`
- `users/{uid}/meta/settings`

系統保護項目：`現金`、`應付帳款`、`薪資收入`、`餐飲費`。這四個項目固定 `order = 0`，不能改名、改次序或刪除。

## 匯入項目 CSV 格式範例

`匯入項目` 目前會讀取下列欄位：

- 必填：`類別`、`項目名稱`
- 選填：`期初餘額`、`次序`、`常用摘要`

說明：

- `類別` 可用：`資產`、`負債`、`收入`、`支出`、`業外收入`、`業外支出`
- `期初餘額` 只對 `資產`、`負債` 生效，空白時視為 `0`
- `次序` 空白時會自動補下一個次序
- `常用摘要` 只對分類項目生效，可用 `；` 分隔多筆，最多保留 6 筆
- `保護項目`、`ID` 即使存在於 CSV，也不會影響匯入結果

範例：

```csv
類別,項目名稱,期初餘額,次序,常用摘要
資產,現金,5000,0,
負債,應付帳款,0,0,
收入,薪資收入,,0,月薪；年終
支出,餐飲費,,0,早餐；午餐；晚餐
業外收入,利息,,0,活存利息；定存利息
業外支出,保規費,,0,壽險；醫療險
```

## 匯入記錄 CSV 格式範例

`匯入記錄` 目前會讀取下列欄位：

- 必填：`日期`、`從項目`、`至項目`、`金額`
- 選填：`摘要`、`備註`

說明：

- `從項目`、`至項目` 必須是資料庫裡已存在的項目名稱
- 系統會依 `從項目` 與 `至項目` 自動判斷記錄類型，不依賴 `類型` 欄位
- `摘要`、`備註` 可留空
- 不合法的記錄路徑或格式錯誤資料會被略過，不會匯入

範例：

```csv
日期,從項目,至項目,金額,摘要,備註
2026-04-01,薪資收入,現金,50000,四月薪資,
2026-04-02,現金,餐飲費,120,早餐,
2026-04-03,利息,現金,35,活存利息,
2026-04-04,現金,應付帳款,5000,信用卡還款,四月帳單
```
