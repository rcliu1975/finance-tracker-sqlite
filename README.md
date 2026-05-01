# 家庭理財記帳

> 這個 repo 是從 `finance-tracking` 拆出的 `SQLite` 遷移專案。  
> 目前以 SQLite 工作流為主，Firebase / Firestore 僅保留相容路徑。

這是一個以 SQLite 為主、保留 Firebase / Firestore 相容能力的前端記帳工具，適合用來管理家庭收支、固定支出與基礎財務分析。

SQLite-only 啟動可直接看：

- [`SQLITE_QUICKSTART.md`](/home/roger/WorkSpace/finance-tracker-sqlite/SQLITE_QUICKSTART.md)

如果你要讓 SQLite UI 從外網登入，也看這份 quickstart。
目前 SQLite bridge 外網模式提供的是既有帳號登入，不是前端自助註冊。

## SQLite 遷移現況

- 已建立初版 SQLite schema：[sqlite/schema.sql](sqlite/schema.sql)
- 已整理 Firestore 對 SQLite 的資料對照：[sqlite/README.md](sqlite/README.md)
- 已有統一 SQLite 匯入入口：`scripts/import-to-sqlite.py`
- `sqlite:import-firestore`、`sqlite:import-csv`、`sqlite:import-items` 都已整合到同一支主程式
- 已有 SQLite 項目 CSV 匯出腳本：`scripts/export-items-from-sqlite.py`
- 已有 SQLite 記錄 CSV 匯出腳本：`scripts/export-records-from-sqlite.py`
- 已有桌面側欄月矩陣 CSV 匯出腳本：`scripts/export-desktop-sidebar-matrix.py`
- 已有 SQLite -> 前端 seed JSON 匯出腳本：`scripts/export-sqlite-to-json.py`
- 已有 SQLite 月快照重建腳本：`scripts/rebuild-sqlite-snapshots.py`
- 已有 SQLite 驗證腳本：`scripts/verify-sqlite-db.py`
- 已有 SQLite HTTP bridge：`scripts/sqlite-http-bridge.py`
- 前端已改成透過 `data/app-data-backend.js` 讀寫資料，為接上 SQLite backend 預留穩定介面
- 前端 runtime / session 已改成透過 `data/app-runtime.js` 進入，減少 `app.js` 對 Firebase 專名的直接耦合
- 前端 session/bootstrap 初始化已抽到 `data/app-session.js`
- 已加入 `APP_STORAGE_BACKEND=sqlite` provider 切換；目前可透過 `APP_SQLITE_API_BASE_URL` 直接連本機 SQLite bridge，`seed JSON + localStorage` 改為 fallback
- `commonSummaries` 在 SQLite bridge 模式下也會直接持久化到 SQLite，不再只靠瀏覽器 `localStorage`
- 線上項目匯入 / 匯出入口已移除，改走 `scripts/` 下的 command line 工具

### SQLite 匯入流程

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

### SQLite bridge + serve 流程

這條流程只負責把既有 SQLite `.db` 接到前端，不包含任何匯入動作。

最簡單的啟動方式：

```bash
npm run sqlite:frontend -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user
```

這支腳本會做三件事：

1. 產生 `app-config.js`
2. 啟動 `sqlite-http-bridge.py`
3. 啟動前端靜態 server

按 `Ctrl+C` 會一起停止 bridge 與前端 server。

如果你要分開控制 bridge 與 serve，仍可各自啟動：

```bash
npm run sqlite:bridge -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user

npm run serve
```

## Command line 項目匯入 / 匯出

前端已移除線上 `項目匯入` / `項目匯出`，改成只保留 command line 流程。

### 外幣版 CSV 範例

若要先看外幣帳戶規劃中的 CSV 格式範例，可產生參考檔：

```bash
npm run sqlite:generate-fx-csv-examples -- \
  --output-dir ./.tmp/foreign-currency-csv-examples
```

會在指定目錄產生兩份範例：

- `items-foreign-currency-example.csv`
- `transactions-foreign-currency-example.csv`

若你手上是舊版匯入 CSV，可先轉成新版外幣規劃格式：

```bash
npm run sqlite:convert-legacy-csv -- \
  --legacy-items-csv ~/item_2025_UTF-8_import.csv \
  --legacy-transactions-csv ~/transactionP-2025_utf-8_import.csv \
  --output-dir ./.tmp/converted-foreign-currency-csv
```

轉換結果：

- 項目 CSV 會新增 `幣別` 欄位
- 舊版 `金額` 會展開成新版 `從金額` / `至金額`
- 帳戶列 `幣別` 會先用 `--base-currency` 補預設值，預設為 `TWD`

目前規劃中的欄位方向：

- 項目 CSV
  - 帳戶列新增 `幣別`
  - 分類列的 `幣別` 保持空白
- 交易 CSV
  - 改成 `從金額` / `至金額`
  - 本幣交易兩欄數值通常相同
  - 涉及外幣帳戶時，兩欄可不同

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
- `幣別`
- `期初餘額`
- `次序`
- `保護項目`
- `ID`
- `常用摘要`

說明：

- 現行 schema 若尚未加入 `accounts.currency`，帳戶列 `幣別` 會先預設輸出為 `TWD`
- 分類列 `幣別` 會保持空白

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
- 帳戶列可直接提供 `幣別`；若現行 schema 尚未加入 `accounts.currency`，會先接受但不寫入資料庫
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

## Command line 桌面側欄月矩陣匯出

若需要依桌面版側欄順序，把總資產負債結餘、各群組與各項目展開成「列」，並把月份展開成「欄」：

```bash
npm run sqlite:export-sidebar-matrix -- \
  --db ~/finance-tracker-sqlite-test.db \
  --output ~/desktop-sidebar-matrix.csv
```

說明：

- `--db`：來源 SQLite 資料庫
- `--output`：輸出的 CSV 檔案路徑
- `--user-id`：可選；未指定時取資料庫內第一個 user
- `--start-month`：可選；預設 `2009-08`
- `--end-month`：可選；未指定時取資料庫內最後一個 snapshot 月份

輸出結構：

- 左側固定欄位：
  - `順序`
  - `群組`
  - `列類型`
  - `名稱`
  - `ID`
- 右側月份欄位：
  - 例如 `2009/8`、`2009/9`、`2009/10`

列順序會對齊桌面版側欄：

1. `總資產負債結餘`
2. `資產` 群組與其帳戶
3. `負債` 群組與其帳戶
4. `收入` 群組與其分類
5. `支出` 群組與其分類
6. `業外收入` 群組與其分類
7. `業外支出` 群組與其分類

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
- `app.js`: 前端資料流程、互動與畫面渲染
- `.env.example`: 本機與部署用設定範本
- `app-config.example.js`: 通用前端設定範本
- `firebase-config.example.js`: 舊檔名相容範本
- `firebase.json`: Firebase Hosting 設定
- `firestore.rules`: Firestore 權限規則，只允許登入者存取自己的 `users/{uid}` 資料
- `.firebaserc`: Firebase 專案綁定設定
- `scripts/deploy.sh`: Unix-like 環境部署腳本
- `scripts/deploy.ps1`: Windows PowerShell 部署腳本
- `scripts/cleanup-orphan-users.js`: 比對 Firebase Authentication 與 Firestore `users/{uid}`，清理不存在帳號的使用者資料
- `scripts/generate-app-config.js`: 依 `.env` 產生 `app-config.js`
- `scripts/generate-firebase-config.js`: 舊腳本名稱相容保留
- `scripts/import-records-cli.js`: 在 command line 下匯入記錄 CSV，支援 dry-run、Emulator 與正式 Firestore
- `scripts/import-to-sqlite.py`: 統一 SQLite 匯入主入口，支援 `firestore`、`csv`、`items` 三種來源
- `scripts/export-items-from-sqlite.py`: 從 SQLite 資料庫匯出項目 CSV
- `scripts/export-records-from-sqlite.py`: 從 SQLite 資料庫匯出記錄 CSV
- `scripts/export-desktop-sidebar-matrix.py`: 依桌面側欄順序匯出月矩陣 CSV
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

前端 `設定` 分頁也會在這個模式下顯示 bridge 管理卡片，可直接查看狀態與手動重建 snapshot。

如果要讓同網段或其他裝置連進來，請把 bridge 與前端都綁到外部位址，並把公開位址寫進前端設定：

```bash
npm run sqlite:frontend -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user \
  --bridge-host 0.0.0.0 \
  --serve-host 0.0.0.0 \
  --open-host 192.168.1.10
```

說明：

- `--bridge-host`：bridge 實際監聽位址
- `--serve-host`：前端靜態 server 監聽位址
- `--open-host`：寫入 `app-config.js` 的公開位址；遠端裝置會用它連 bridge

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

## Firebase / Firestore 相容流程

SQLite 主線之外的相容說明已移到：

- [`FIRESTORE_COMPAT.md`](/home/roger/WorkSpace/finance-tracker-sqlite/FIRESTORE_COMPAT.md)

這份相容文件包含：

- Production / Emulator 連線方式
- Firebase Hosting 部署
- 孤兒使用者資料清理
- Firestore 記錄匯入
- Firestore 月快照重建
- 目前 Firebase 資料結構

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

`匯入記錄` CLI 目前可讀兩種格式：

- 舊版：`日期`、`從項目`、`至項目`、`金額`
- 新版：`日期`、`從項目`、`從金額`、`至項目`、`至金額`

- 選填：`摘要`、`備註`

說明：

- `從項目`、`至項目` 必須是資料庫裡已存在的項目名稱
- 系統會依 `從項目` 與 `至項目` 自動判斷記錄類型，不依賴 `類型` 欄位
- `摘要`、`備註` 可留空
- 不合法的記錄路徑或格式錯誤資料會被略過，不會匯入
- 在資料庫 schema 還沒切到 `from_amount` / `to_amount` 前，新版 `從金額` 與 `至金額` 若不同，匯入會直接拒絕

範例：

```csv
日期,從項目,至項目,金額,摘要,備註
2026-04-01,薪資收入,現金,50000,四月薪資,
2026-04-02,現金,餐飲費,120,早餐,
2026-04-03,利息,現金,35,活存利息,
2026-04-04,現金,應付帳款,5000,信用卡還款,四月帳單
```

外幣版規劃中的新格式則改成：

```csv
日期,從項目,從金額,至項目,至金額,摘要,備註
2026-04-01,薪資收入,50000,現金,50000,四月薪資,
2026-04-02,現金,120,餐飲費,120,早餐,
2026-04-03,現金,32000,美元帳戶,1000,換匯買美元,
2026-04-04,現金,5000,應付帳款,5000,信用卡還款,四月帳單
```

目前 `sqlite:export-records` 已改成輸出新欄位名稱；若來源資料仍是舊 schema，會先把單一金額展開成相同的 `從金額` / `至金額`。
