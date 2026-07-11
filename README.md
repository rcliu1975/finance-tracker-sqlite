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
  --items-csv "~/items-foreign-currency-import.csv" \
  --transactions-csv "~/transactions-foreign-currency-import.csv" \
  --user-id local-user \
  --replace
```

`sqlite:import-csv` 會建立 / 更新 SQLite database，匯入項目與交易，並自動重建 `monthly_snapshots`。
重建後：

- `income_total` 只代表一般 `income`
- `expense_total` 只代表一般 `expense`
- `nonOperatingIncome` / `nonOperatingExpense` 會保留在 `category_totals_json`，由 UI 與匯出工具依分類型別分開加總

匯入後建議驗證一次：

```bash
npm run sqlite:verify-db -- --db "$DB" --user-id local-user
```

注意：

- `--db` 建議放在 repo 外面，不要把私人 `.db` commit 進 repo。
- `--replace` 會覆蓋既有 database。
- 不使用 `--replace` 時，如果該 user 已有 transaction，匯入會拒絕，避免重複灌資料。
- 可選的 `--user-email` / `--display-name` 只會寫入 SQLite user metadata，和 UI 登入無關。

### 4. 給 Cloudflared 使用的啟動方式

這一節預設用「單一 Cloudflared tunnel + 同一個公開 origin」連入，例如 `https://moneybook.example.com`。SQLite bridge 現在預設需要登入；正式環境請用環境變數傳入帳密，不要把密碼放進 shell history 或文件。

```bash
export LOGIN_EMAIL=you@example.com
export LOGIN_PASSWORD='<strong-password>'

npm run sqlite:frontend -- \
  --db "$DB" \
  --user-id local-user \
  --bridge-host 127.0.0.1 \
  --serve-host 127.0.0.1 \
  --public-origin https://moneybook.example.com \
  --login-email-env LOGIN_EMAIL \
  --login-password-env LOGIN_PASSWORD
```

這個指令會：

1. 產生 `app-config.js`
2. 啟動 SQLite HTTP bridge
3. 啟動只允許必要前端檔案的靜態 server

本機會開：

- Frontend: `http://127.0.0.1:5173`
- SQLite bridge: `http://127.0.0.1:8765`

前端 `app-config.js` 會使用：

```text
APP_SQLITE_API_BASE_URL=https://moneybook.example.com/bridge
```

也就是 browser 讀 `index.html` 與呼叫 SQLite bridge，都走同一個公開 origin。

按 `Ctrl+C` 可同時停止 bridge 與前端 server。

#### 架構

```text
Browser
  -> https://moneybook.example.com
  -> Cloudflared tunnel
  -> 本機 reverse proxy（Caddy 或 nginx，假設 listen 127.0.0.1:8080）
     -> /        轉給 http://127.0.0.1:5173
     -> /bridge/ 轉給 http://127.0.0.1:8765
```

這個做法的重點：

- 外部只看到一個 hostname：`moneybook.example.com`
- 不需要把 `5173` 或 `8765` 直接暴露到外網
- browser 端是 same-origin，通常不需要額外處理 CORS
- bridge 內建 email/password 是預設保護；Cloudflare Access、反向代理 Basic Auth 或 Tailscale ACL 可當第二層

#### Cloudflared 設定

`~/.cloudflared/config.yml`：

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/<user>/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: moneybook.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

啟動：

```bash
cloudflared tunnel run <your-tunnel-name>
```

#### Caddyfile 範例

`Caddyfile`：

```caddy
:8080 {
  handle_path /bridge/* {
    reverse_proxy 127.0.0.1:8765
  }

  handle {
    reverse_proxy 127.0.0.1:5173
  }
}
```

啟動 Caddy：

```bash
caddy run --config /path/to/Caddyfile
```

`handle_path /bridge/*` 會把 `/bridge` 前綴剝掉，所以 SQLite bridge 實際收到的是 `/session/config`、`/health` 這種原本就支援的路徑。

#### 啟用順序

1. 啟動 SQLite 前端與 bridge：

```bash
export LOGIN_EMAIL=you@example.com
export LOGIN_PASSWORD='<strong-password>'

npm run sqlite:frontend -- \
  --db "$DB" \
  --user-id local-user \
  --bridge-host 127.0.0.1 \
  --serve-host 127.0.0.1 \
  --public-origin https://moneybook.example.com \
  --login-email-env LOGIN_EMAIL \
  --login-password-env LOGIN_PASSWORD
```

2. 啟動 Caddy 或 nginx，讓 `127.0.0.1:8080` 同時代理前端與 `/bridge/`
3. 啟動 `cloudflared tunnel run <your-tunnel-name>`
4. 從外部打開 `https://moneybook.example.com`

#### 正式站固定更新流程

如果你平常是用：

- `npm run sqlite:frontend -- ...`
- `cloudflared tunnel run <your-tunnel-name>`
- `/etc/caddy/Caddyfile`

那正式站更新的固定操作建議如下。

1. 修改前端 / bridge 程式碼後，先確認本機檔案已更新。
2. 如果有改到 `app.js`、`styles.css` 這種靜態檔，優先做 cache bust：

```html
<script type="module" src="app.js?v=20260502-2132"></script>
```

或等價地更新 `styles.css?v=...`。原因是 Cloudflare 可能持續快取舊版靜態檔，只重開 process 不一定會立刻生效。

3. 停掉舊的 `sqlite:frontend` 與 `cloudflared`。
4. 重新啟動 SQLite 前端與 bridge：

```bash
export LOGIN_EMAIL=you@example.com
export LOGIN_PASSWORD='<strong-password>'

npm run sqlite:frontend -- \
  --db ~/finance-tracker.db \
  --user-id local-user \
  --bridge-host 127.0.0.1 \
  --serve-host 127.0.0.1 \
  --public-origin https://moneybook.example.com \
  --login-email-env LOGIN_EMAIL \
  --login-password-env LOGIN_PASSWORD
```

5. 確認 Caddy 仍在把：

- `/` 代理到 `127.0.0.1:5173`
- `/bridge/` 代理到 `127.0.0.1:8765`

如果只改前端或 bridge 程式，通常不需要重啟 Caddy；只有 `Caddyfile` 有變更時才需要 reload / restart。

6. 重新啟動 tunnel：

```bash
cloudflared tunnel run <your-tunnel-name>
```


這個安裝腳本會：

1. 建立 `finance-tracker-sqlite-frontend.service`
2. 建立 `~/.config/finance-tracker-sqlite/systemd.env`
3. `systemctl --user daemon-reload`
4. `systemctl --user enable --now finance-tracker-sqlite-frontend.service`

登入帳密不會直接寫進 unit 檔，而是放在只有目前使用者可讀的 `~/.config/finance-tracker-sqlite/systemd.env`。

管理指令：

```bash
systemctl --user status finance-tracker-sqlite-frontend.service
journalctl --user -u finance-tracker-sqlite-frontend.service -f
```

7. 驗證公開站是否已吃到新版本：

```bash
curl -fsSL 'https://moneybook.example.com/app.js?v=check' | rg 'invalidateDerivedDataCache'
```

如果是檢查 UI 數字，請直接到公開站重新登入並確認目標月份畫面。

#### 本機開發無登入模式

SQLite bridge 預設要求 email/password。只有在隔離的本機開發環境，才建議明確加 `--allow-unauthenticated`：

```bash
npm run sqlite:frontend -- \
  --db "$DB" \
  --user-id local-user \
  --bridge-host 127.0.0.1 \
  --serve-host 127.0.0.1 \
  --allow-unauthenticated
```

對外開放時不要使用 `--allow-unauthenticated`。bridge 的 email / password 是 SQLite bridge 的 UI 登入保護，不是前端註冊帳號；資料仍歸屬於 `--user-id` 指定的 SQLite user。

### 5. 登入 UI 開始使用

打開前端網址後，用剛才設定的 email / password 登入。

SQLite bridge 登入是本機 bridge 的保護層，不是前端自助註冊。資料仍歸屬於 `--user-id` 指定的 SQLite user。

### 6. Server 端未備份到 GitHub 的檔案

以下檔案或目錄和正式服務運作有關，但不會備份到 GitHub。換機、重裝或災難復原時要另外備份或重建：

| 路徑                                                               | 用途                             | 備註                                                        |
| ---------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| `.env`                                                           | 產生 `app-config.js` 的本機設定來源     | 已被 `.gitignore` 排除；不要放密碼到 repo                            |
| `app-config.js`                                                  | 前端實際載入的 runtime 設定             | 由 `scripts/generate-app-config.js` 或 `sqlite:frontend` 產生 |
| `~/finance-tracker.db`                                           | 正式 SQLite database             | 私人財務資料，應放 repo 外並定期備份                                     |
| `~/finance-tracker-backups/`                                     | 匯出的 CSV / JSON 備份              | 依你的備份路徑調整                                                 |
| `~/.config/finance-tracker-sqlite/systemd.env`                   | user-level systemd 啟動用環境變數     | 包含 bridge login；權限應為 `600`                                |
| `~/.config/systemd/user/finance-tracker-sqlite-frontend.service` | 前端與 bridge 的 user service      | 由 `scripts/install_cloudflared_systemd_user.sh` 建立        |
| `~/.cloudflared/config.yml`                                      | Cloudflared tunnel ingress 設定  | 不在 repo；包含 tunnel 名稱與 ingress                             |
| `~/.cloudflared/<tunnel-id>.json`                                | Cloudflared tunnel credentials | 敏感檔案，權限應限目前使用者                                            |
| `/etc/caddy/Caddyfile`                                           | 正式反向代理設定                       | 系統層設定，不在 repo                                             |


#### 對外服務基礎設施

| 路徑                                                               | 必要性 | 說明                                         |
| ---------------------------------------------------------------- | --- | ------------------------------------------ |
| `~/.config/finance-tracker-sqlite/systemd.env`                   | 必要  | user-level systemd 啟動用環境變數，包含 bridge login |
| `~/.config/systemd/user/finance-tracker-sqlite-frontend.service` | 建議  | 前端與 bridge 的 user service                  |
| `~/.cloudflared/config.yml`                                      | 必要  | tunnel ingress 設定                          |
| `~/.cloudflared/<tunnel-id>.json`                                | 必要  | tunnel credentials                         |
| `/etc/caddy/Caddyfile`                                           | 必要  | 正式反向代理設定                                   |

備份優先順序建議如下：

1. `~/finance-tracker.db`
2. `.env`
3. `~/.config/finance-tracker-sqlite/systemd.env`
4. `~/.cloudflared/config.yml`
5. `~/.cloudflared/<tunnel-id>.json`
6. `/etc/caddy/Caddyfile`
7. `~/finance-tracker-backups/`
8. `app-config.js`、systemd service files、Firebase 相容檔案

```bash
systemctl --user restart finance-tracker-sqlite-frontend.service
systemctl --user restart finance-tracker-sqlite-cloudflared.service
sudo systemctl reload caddy
npm run sqlite:verify-db -- --db "$DB" --user-id local-user
```

如果新機器上的 database 路徑、網域、tunnel 名稱、bridge 監聽位址有改，記得同步更新 `.env`、`systemd.env`、`~/.cloudflared/config.yml` 與 `/etc/caddy/Caddyfile`。

### 9. 必要時更新 snapshot

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

這個重建流程會重新寫入整段 `monthly_snapshots`。目前 `income_total` / `expense_total` 只對應一般收入 / 支出；業外項目請看 `categoryTotals` 或 UI 的 `業外收入` / `業外支出` 群組。

### 10. 經常匯出 CSV 備份

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

`sqlite:frontend` 會自動把前端來源加入 bridge 的 CORS allow-list，並用 allowlist 靜態 server 只服務 `index.html`、前端 JS/CSS、設定檔與 `data/*.js`。

SQLite bridge 預設需要登入。正式環境請用 `--login-email-env` / `--login-password-env`，避免密碼出現在子程序 argv。若你手動分開啟動 bridge 與前端，必須明確指定 `--cors-origin`：

```bash
export LOGIN_EMAIL=you@example.com
export LOGIN_PASSWORD='<strong-password>'

npm run sqlite:bridge -- \
  --db "$DB" \
  --user-id local-user \
  --cors-origin http://127.0.0.1:5173 \
  --login-email-env LOGIN_EMAIL \
  --login-password-env LOGIN_PASSWORD
```

bridge 對 browser request 會檢查 Origin；寫入 request body 必須使用 `Content-Type: application/json`。

CORS 只處理「哪個瀏覽器 origin 可以呼叫 bridge」，不處理「誰有權限操作資料」。如果你用反向代理把前端與 bridge 合成同一個對外 origin，browser 端甚至不需要 CORS；但 bridge API 仍然是公開的 HTTP 入口，所以對外服務必須保留 bridge 登入或放在等價的外層存取控制後面。`--allow-unauthenticated` 只給隔離的本機開發使用。

## 專案檔案

- [app.js](app.js): 前端資料流程、互動與畫面渲染
- [index.html](index.html): 主要頁面
- [styles.css](styles.css): 視覺樣式
- [sqlite/schema.sql](sqlite/schema.sql): SQLite schema
- [scripts/import-to-sqlite.py](scripts/import-to-sqlite.py): 統一 SQLite 匯入入口
- [scripts/run-sqlite-frontend.py](scripts/run-sqlite-frontend.py): 一鍵啟動 SQLite bridge + Web UI
- [scripts/serve-static-frontend.py](scripts/serve-static-frontend.py): 只服務必要前端檔案的 allowlist 靜態 server
- [scripts/sqlite-http-bridge.py](scripts/sqlite-http-bridge.py): SQLite HTTP bridge
- [scripts/rebuild-sqlite-snapshots.py](scripts/rebuild-sqlite-snapshots.py): 重建月快照
- [scripts/verify-sqlite-db.py](scripts/verify-sqlite-db.py): 驗證 SQLite database
- [FIRESTORE_COMPAT.md](FIRESTORE_COMPAT.md): Firebase / Firestore 相容流程

## 補充文件

- [SNAPSHOT_BEHAVIOR.md](SNAPSHOT_BEHAVIOR.md): 哪些操作會標 dirty、哪些會直接重建 snapshot
- [SQLITE_QUICKSTART.md](SQLITE_QUICKSTART.md): SQLite 快速啟動筆記
- [sqlite/README.md](sqlite/README.md): SQLite schema 與資料對照
- [sqlite/firestore-mapping.md](sqlite/firestore-mapping.md): Firestore 到 SQLite 對照

## scripts 補充索引

日常操作優先使用 `npm run ...` wrapper；直接執行 `scripts/*` 主要用於除錯或需要繞過 npm 時。

---

## 手動設定 User-Level Systemd 自動維護

如果您不想使用 `scripts/install_cloudflared_systemd_user.sh` 腳本，可以依照以下步驟手動完成 user-level systemd 服務的設定與維護。

### 步驟 1：建立環境變數檔案
為了安全起見，登入帳密與路徑設定不寫入 systemd 服務檔，而是放在獨立的環境變數檔案中。

1. **建立設定目錄並限制權限**：
   ```bash
   mkdir -p ~/.config/finance-tracker-sqlite
   chmod 700 ~/.config/finance-tracker-sqlite
   ```

2. **建立 `~/.config/finance-tracker-sqlite/systemd.env` 檔案**：
   ```ini
   # 您的資料庫檔案路徑 (例如放在首頁目錄下)
   DB_PATH='/home/user/finance-tracker.db'
   
   # 使用者識別碼
   USER_ID='local-user'
   
   # Bridge 與前端服務監聽的位址
   BRIDGE_HOST='127.0.0.1'
   SERVE_HOST='127.0.0.1'
   
   # 您的外部公開網址 (例如 Cloudflare Tunnel 對應的網域)
   PUBLIC_ORIGIN='https://moneybook.example.com'
   
   # Bridge 登入帳密設定
   LOGIN_EMAIL='you@example.com'
   LOGIN_PASSWORD='your-strong-password'
   
   # npm 執行檔路徑 (可使用 `command -v npm` 取得)
   NPM_BIN='/usr/bin/npm'
   
   # 系統 PATH 設定，必須包含 npm 執行檔所在的目錄
   PATH='/usr/bin:/usr/local/bin:/bin'
   ```

3. **保護環境變數檔案權限**：
   ```bash
   chmod 600 ~/.config/finance-tracker-sqlite/systemd.env
   ```

### 步驟 2：建立 Systemd User Service 檔案
1. **建立 systemd user 設定目錄**（如尚未建立）：
   ```bash
   mkdir -p ~/.config/systemd/user
   ```

2. **建立服務設定檔 `~/.config/systemd/user/finance-tracker-sqlite-frontend.service`**：
   ```ini
   [Unit]
   Description=Finance Tracker SQLite frontend
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   WorkingDirectory=/home/user/WorkSpace/finance-tracker-sqlite
   EnvironmentFile=%h/.config/finance-tracker-sqlite/systemd.env
   ExecStart=/usr/bin/env bash -lc 'exec "$NPM_BIN" run sqlite:frontend -- --db "$DB_PATH" --user-id "$USER_ID" --bridge-host "$BRIDGE_HOST" --serve-host "$SERVE_HOST" --public-origin "$PUBLIC_ORIGIN" --login-email-env LOGIN_EMAIL --login-password-env LOGIN_PASSWORD'
   Restart=always
   RestartSec=3

   [Install]
   WantedBy=default.target
   ```
   
# 備份至 Borg archive 流程

 `finance-tracker-sqlite` 可以從 GitHub `git clone` 取得，Borg 只需保存「資料」與「必要的本機設定」。

### 需要放進 Borg 的內容

- `~/finance-tracker.db`
- `~/WorkSpace/finance-tracker-sqlite/.env`
- `~/.config/finance-tracker-sqlite/systemd.env`
- `~/.config/systemd/user/finance-tracker-sqlite-frontend.service`
- `匯出的 .csv`

### Ubuntu 安裝 Borg

```bash
sudo apt update
sudo apt install borgbackup
```

## 步驟 1: 初始化 repo

```bash
borg init --encryption=none rcliu@qnap:/share/Backup3/BorgRepo_finance-tracker --remote-path /opt/bin/borg
```

### 步驟 2: 匯出可讀格式

先把資料匯出成 CSV / JSON，讓未來即使 SQLite schema 有變，也能重新建立資料。`~/finance-tracker-backups/latest/` 只保留最新一份。

```bash
rm -rf "$HOME/finance-tracker-backups/latest"
mkdir -p "$HOME/finance-tracker-backups/latest"

cd "$HOME/WorkSpace/finance-tracker-sqlite"
npm run sqlite:export-items -- --db "$HOME/finance-tracker.db" --output "$HOME/finance-tracker-backups/latest/items.csv"
npm run sqlite:export-records -- --db "$HOME/finance-tracker.db" --output "$HOME/finance-tracker-backups/latest/records.csv"
npm run sqlite:export-json -- --db "$HOME/finance-tracker.db" --output "$HOME/finance-tracker-backups/latest/export.json"
```

### 步驟 3: 暫停會寫入 DB 的服務

```bash
systemctl --user stop finance-tracker-sqlite-frontend.service 2>/dev/null || true
```

### 步驟 4: 複製 `finance-tracker.db` ，`finance-tracker-sqlite-frontend.service` ，`systemd.env` 和  `.env`

```bash
cd "$HOME"
cp finance-tracker.db finance-tracker-backups/latest
cp .config/systemd/user/finance-tracker-sqlite-frontend.service finance-tracker-backups/latest
cp .config/finance-tracker-sqlite/systemd.env finance-tracker-backups/latest
cp ~/WorkSpace/finance-tracker-sqlite/.env finance-tracker-backups/latest
```

### 步驟 5: 恢復服務

```bash
systemctl --user start finance-tracker-sqlite-frontend.service
```

### 步驟 6: 寫入 Borg repository

```bash
cd "$HOME"
borg create --stats --progress rcliu@qnap:/share/Backup3/BorgRepo_finance-tracker::finance-tracker-$(date +%F) finance-tracker-backups/latest --remote-path /opt/bin/borg
```

### 清理舊 archive

用 prune 清理歷史版本

```bash
borg prune -v --list rcliu@qnap:/share/Backup3/BorgRepo_finance-tracker --glob-archives 'finance-tracker-*' --keep-daily=7 --keep-weekly=4 --keep-monthly=12
borg compact ssh://backup-host/./borg/finance-tracker
```

borg prune 會保留：最近 7 天的每日備份, 最近 4 週的每週備份, 最近 12 個月的每月備份

# 由 Borg archive 還原到新電腦的流程

先安裝 `git`

```bash
sudo apt install git
```

### 步驟 1: 在新電腦 clone repo

複製 ssh 金鑰 `id_ed25519`, `id_ed25519.pub` 到 `~/.ssh`

```bash
mkdir -p "$HOME/WorkSpace"
cd "$HOME/WorkSpace"
git clone git@github.com:rcliu1975/finance-tracker-sqlite
cd finance-tracker-sqlite
npm install
```

### 步驟 2: 從 Borg 還原 archive

Ubuntu 安裝 Borg

```bash
sudo apt update
sudo apt install borgbackup
```

列出 archive

```bash
borg list rcliu@qnap:/share/Backup3/BorgRepo_finance-tracker --remote-path /opt/bin/borg
```

```bash
DATECODE=2026-07-07
mkdir -p "$HOME/finance-tracker-restore/$DATECODE"
cd "$HOME/finance-tracker-restore/$DATECODE"
borg extract rcliu@qnap:/share/Backup3/BorgRepo_finance-tracker::finance-tracker-$DATECODE --remote-path /opt/bin/borg --strip-components 2
```

### 步驟 3: 放回 SQLite 資料 及 `systemd.env`

```bash
DATECODE=2026-07-07
cp "$HOME/finance-tracker-restore/$DATECODE/finance-tracker.db" "$HOME/finance-tracker.db"
mkdir -p "$HOME/.config/finance-tracker-sqlite"
cp "$HOME/finance-tracker-restore/$DATECODE/systemd.env" "$HOME/.config/finance-tracker-sqlite/systemd.env"
chmod 600 "$HOME/.config/finance-tracker-sqlite/systemd.env"
```

如果 `systemd.env` 內有 `npm` 路徑，請依新電腦上的位置調整，例如 `/home/user/.nvm/versions/node/v22.23.1/bin/npm`

```bash
which npm
```

檢查 system.env 及根據 server name 和 npm path 修正 PUBLIC_ORIGIN, NPM_BIN 和 NPM_BIN

### 步驟 4: 放回 `.env`

```bash
cp "$HOME/finance-tracker-restore/$DATECODE/.env" "$HOME/WorkSpace/finance-tracker-sqlite/.env"
```

檢查 .env 及根據 server name 修正 APP_SQLITE_API_BASE_URL

### 步驟 5: 重新產生 app-config.js

用 `.env` 產生 `app-config.js`。

```bash
cd "$HOME/WorkSpace/finance-tracker-sqlite"
npm run config:generate
```

### 步驟 6: 建立 frontend systemd service

```bash
DATECODE=2026-07-07
mkdir -p "$HOME/.config/systemd/user"
cp "$HOME/finance-tracker-restore/$DATECODE/finance-tracker-sqlite-frontend.service" "$HOME/.config/systemd/user/finance-tracker-sqlite-frontend.service"
```

   > [!IMPORTANT]
   > 請確保 `WorkingDirectory` 設定為您專案目錄的實際絕對路徑。


**新建立的 service 要先 enable**

```bash
systemctl --user daemon-reload
systemctl --user enable --now finance-tracker-sqlite-frontend.service
```

**若是修改已 enable  的 service 只需 restart**

```bash
systemctl --user daemon-reload
systemctl --user restart finance-tracker-sqlite-frontend.service
```

**啟用 Linger（使 systemd user service 在重開機後尚未登入桌面也自動啟動起來）**：

   ```bash
   sudo loginctl enable-linger $USER
   ```

驗證服務能不能連上：

```bash
curl -I http://127.0.0.1:5173
curl -I http://127.0.0.1:8765
```


### 步驟 7: 重新安裝 cloudflared

在新電腦上重新建立 `cloudflared`。

```bash
cloudflared tunnel login
cloudflared tunnel create <your-tunnel-name>
mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<'EOF'
tunnel: <your-tunnel-id>
credentials-file: ~/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: moneybook.example.com
    service: http://127.0.0.1:8000
  - service: http_status:404
EOF
```

如果你需要 DNS 綁定，再執行：

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
cloudflared tunnel route dns <your-tunnel-name> moneybook.example.com
```

建立 user-level systemd 配置目錄：

```bash
mkdir -p ~/.config/systemd/user
```

建立服務設定檔 `~/.config/systemd/user/cloudflared-tunnel.service`：

```ini
[Unit]
Description=Cloudflare Tunnel - user mode
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/cloudflared tunnel --config %h/.cloudflared/config.yml run
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```
  
   *(註：%h 在 systemd 中會自動替換為使用者的 Home 目錄)*

修改後驗證：

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
```

若 service 正在運行，再重啟：

```bash
systemctl --user restart cloudflared-tunnel.service
```

### 步驟 8: 重新安裝 Caddy

在 Ubuntu 24.04 LTS 安裝 Caddy，建議使用官方 APT repository。

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

確認安裝：

```bash
caddy version
sudo systemctl status caddy
```

建立 `/etc/caddy/Caddyfile`：

```bash
sudo mkdir -p /etc/caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
:8000 {
  handle_path /bridge/* {
    reverse_proxy 127.0.0.1:8765
  }

  handle {
    reverse_proxy 127.0.0.1:5173
  }
}
EOF
```

重啟 Caddy：

```bash
sudo systemctl enable caddy
sudo systemctl restart caddy
```

### 步驟 9: 驗證服務

Ubuntu 安裝 rg

```bash
sudo apt update
sudo apt install ripgrep
```

確認本機有在聽的 port：

```bash
ss -ltnp | rg ':5173|:8765|:8000'
```

確認 Caddy 與前端可以正常回應：

```bash
curl -I http://127.0.0.1:5173
curl -I http://127.0.0.1:8765
curl -I http://127.0.0.1:8000
```

最後在專案目錄檢查資料庫：

```bash
cd "$HOME/WorkSpace/finance-tracker-sqlite"
npm run sqlite:verify-db -- --db "$HOME/finance-tracker.db" --user-id local-user
```

# 常用服務維護指令

* **查看服務狀態**：

  ```bash
  systemctl --user status finance-tracker-sqlite-frontend.service
  ```
  
* **查看即時日誌**：

  ```bash
  journalctl --user -u finance-tracker-sqlite-frontend.service -f
  ```
  
* **重啟服務**：

  ```bash
  systemctl --user restart finance-tracker-sqlite-frontend.service
  ```

* **停止與解除安裝服務**：

  ```bash
  systemctl --user disable --now finance-tracker-sqlite-frontend.service
  rm -f ~/.config/systemd/user/finance-tracker-sqlite-frontend.service
  systemctl --user daemon-reload
  ```

# 手動啟動 


* **先把 systemd.env 裡的變數轉成環境變數 再啟動**：  

  ```bash
  cd /home/roger/WorkSpace/finance-tracker-sqlite
  set -a
  source /home/roger/.config/finance-tracker-sqlite/systemd.env
  set +a

  "$NPM_BIN" run sqlite:frontend -- \
    --db "$DB_PATH" \
    --user-id "$USER_ID" \
    --bridge-host "$BRIDGE_HOST" \
    --serve-host "$SERVE_HOST" \
    --public-origin "$PUBLIC_ORIGIN" \
    --login-email-env LOGIN_EMAIL \
    --login-password-env LOGIN_PASSWORD
  ```

