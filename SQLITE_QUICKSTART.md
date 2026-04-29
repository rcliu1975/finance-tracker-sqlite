# SQLite Quickstart

這份文件只保留 SQLite 主流程。

## 1. 用 CSV 建立 SQLite 測試資料庫

```bash
npm run sqlite:import-csv -- \
  --db ~/finance-tracker-sqlite-test.db \
  --items-csv ~/item_2025_UTF-8_import.csv \
  --transactions-csv ~/transactionP-2025_utf-8_import.csv \
  --replace
```

## 2. 啟動前端

最簡單的方式：

```bash
npm run sqlite:frontend -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user
```

這個指令會：

1. 產生 `app-config.js`
2. 啟動 SQLite HTTP bridge
3. 啟動前端靜態 server

## 3. 分開控制 bridge 與前端

```bash
npm run sqlite:bridge -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user

npm run serve
```

`.env`：

```dotenv
APP_STORAGE_BACKEND=sqlite
APP_LOCAL_USER_ID=local-user
APP_SQLITE_API_BASE_URL=http://127.0.0.1:8765
APP_SQLITE_SEED_PATH=
```

## 4. 區網或其他裝置連線

```bash
npm run sqlite:frontend -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user \
  --bridge-host 0.0.0.0 \
  --serve-host 0.0.0.0 \
  --open-host 192.168.1.10
```

## 5. 常用 SQLite CLI

```bash
npm run sqlite:verify-db -- --db ~/finance-tracker-sqlite-test.db
npm run sqlite:rebuild-snapshots -- --db ~/finance-tracker-sqlite-test.db --apply
npm run sqlite:export-items -- --db ~/finance-tracker-sqlite-test.db --output ~/items-export.csv
npm run sqlite:export-records -- --db ~/finance-tracker-sqlite-test.db --output ~/records-export.csv
```

## 6. SQLite seed fallback

先匯出 seed：

```bash
npm run sqlite:export-json -- \
  --db ~/finance-tracker-sqlite-test.db \
  --output ./sqlite-seed.json
```

再設定：

```dotenv
APP_STORAGE_BACKEND=sqlite
APP_LOCAL_USER_ID=local-user
APP_SQLITE_SEED_PATH=/sqlite-seed.json
```

最後啟動：

```bash
npm run serve
```
