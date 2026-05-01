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

SQLite UI 啟動時一定要指定登入帳密。最簡單的方式：

```bash
npm run sqlite:frontend -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user \
  --login-email you@example.com \
  --login-password 'strong-password'
```

這個指令會：

1. 產生 `app-config.js`
2. 啟動 SQLite HTTP bridge
3. 啟動前端靜態 server

如果你要讓外部透過單一 Cloudflared tunnel 連入，建議改用 same-origin reverse proxy：

```bash
npm run sqlite:frontend -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user \
  --bridge-host 127.0.0.1 \
  --serve-host 127.0.0.1 \
  --public-origin https://www.kennylab.online
```

再用 Caddy 或 nginx 在 `127.0.0.1:8080` 代理：

- `/` -> `127.0.0.1:5173`
- `/bridge/` -> `127.0.0.1:8765`

最後讓 Cloudflared tunnel 指到 `http://127.0.0.1:8080`。完整範例請看 [README.md](README.md) 第 4 節。

如果外層沒有 Cloudflare Access 或其他保護，再補上：

```bash
  --login-email you@example.com \
  --login-password 'strong-password'
```

## 3. 分開控制 bridge 與前端

```bash
npm run sqlite:bridge -- \
  --db ~/finance-tracker-sqlite-test.db \
  --user-id local-user \
  --cors-origin http://127.0.0.1:5173

npm run serve
```

`.env`：

```dotenv
APP_STORAGE_BACKEND=sqlite
APP_LOCAL_USER_ID=local-user
APP_SQLITE_API_BASE_URL=http://127.0.0.1:8765
APP_SQLITE_SEED_PATH=
```

## 4. Cloudflared tunnel

```bash
cloudflared tunnel run <your-tunnel-name>
```

## 5. 常用 SQLite CLI

```bash
npm run sqlite:verify-db -- --db ~/finance-tracker-sqlite-test.db
npm run sqlite:rebuild-snapshots -- --db ~/finance-tracker-sqlite-test.db --apply
npm run sqlite:export-items -- --db ~/finance-tracker-sqlite-test.db --output ~/items-export.csv
npm run sqlite:export-records -- --db ~/finance-tracker-sqlite-test.db --output ~/records-export.csv
npm run sqlite:export-sidebar-matrix -- --db ~/finance-tracker-sqlite-test.db --output ~/desktop-sidebar-matrix.csv
```

`sqlite:import-csv` 與 `sqlite:rebuild-snapshots` 都會使用同一套 snapshot builder。現在 `income_total` / `expense_total` 只代表一般收入 / 支出；業外收入 / 支出仍保留在各分類 totals。

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
