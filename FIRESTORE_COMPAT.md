# Firebase / Firestore 相容流程

這份文件只描述相容模式。

如果你現在主要使用 SQLite，先看 [`README.md`](/home/roger/WorkSpace/finance-tracker-sqlite/README.md) 的 SQLite 主流程即可。

## Production 連線

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

## Firebase Emulator

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

這個指令會自動使用：

- 匯入資料目錄：`.firebase/emulator-data`
- 關閉時自動回存：`.firebase/emulator-data`

可用網址：

- App: `http://localhost:5173`
- Firestore Emulator: `http://localhost:8080`
- Auth Emulator: `http://localhost:9099`
- Emulator UI: `http://localhost:4000`

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

## 孤兒使用者資料清理

如果 Firebase Authentication 已刪除某些帳號，但 Firestore `users/{uid}` 還留著資料，可用下列指令清理：

```bash
npm run cleanup:orphan-users
npm run cleanup:orphan-users:apply -- --confirm-project <projectId>
```

## Command line 匯入記錄

```bash
npm run import:records -- --csv ./records.csv --uid <uid> --emulator
npm run import:records -- --csv ./records.csv --email you@example.com --production
npm run import:records -- --csv ./records.csv --uid <uid> --production --apply
```

重點：

- `--uid` 或 `--email` 必填其一
- `--apply` 才會真的寫入
- `--emulator` / `--production` 若都沒指定，會依 `.env` 的 `FIREBASE_USE_EMULATORS` 判定

## Command line 重建月快照

```bash
npm run rebuild:monthly-snapshots -- --uid <uid> --emulator
npm run rebuild:monthly-snapshots -- --email you@example.com --production
npm run rebuild:monthly-snapshots -- --uid <uid> --production --from 2024-01 --apply
```

## Firebase Hosting 發佈內容

- 會部署前端頁面、樣式、JavaScript 與 `app-config.js`
- 不會部署 `.git`、README、部署腳本、Firestore 規則、範例設定檔與本機測試輸出

## 目前 Firebase 資料結構

- `users/{uid}/accounts`
- `users/{uid}/categories`
- `users/{uid}/transactions`
- `users/{uid}/recurring`
- `users/{uid}/meta/settings`
