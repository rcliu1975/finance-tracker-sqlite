# Data Layer Notes

這個目錄先放 `finance-tracker-sqlite` 的資料層切分。

目前分工：

- `app-data-backend.js`
  前端固定依賴入口。現在會依 `providerKey` 切到 Firebase 或 SQLite backend。
- `app-runtime.js`
  前端固定依賴的 runtime / auth 入口。現在會依 runtime 設定切換 Firebase、SQLite HTTP bridge 或 seed fallback 模式。
- `firebase-backend.js`
  集中 Firebase SDK import、`app-config.js` / `firebase-config.js` 載入，以及 Firestore / Auth 初始化。
- `firebase-data-backend.js`
  Firebase 版資料 backend factory，把 `db/uid` 綁成前端可直接呼叫的 API。
- `sqlite-data-backend.js`
  SQLite 遷移期的前端 backend。現在優先支援 SQLite HTTP bridge；若沒設定 API base URL，才退回 seed JSON + `localStorage` fallback。
- `firestore-user-paths.js`
  集中 `users/{uid}/...` 文件與集合路徑 helper。

目前已經有初步的 backend abstraction，先把下列責任從 `app.js` 抽出去：

1. SDK 依賴來源
2. Firestore 路徑結構
3. 主要讀取 query
4. 交易、設定與項目管理的核心寫入 API
5. `db/uid` 綁定與 app-facing method 形狀
6. runtime bootstrap 與 auth action 入口
7. backend provider 切換骨架
8. SQLite seed 載入與前端本地持久化 fallback
9. SQLite HTTP bridge API 對接
10. SQLite bridge 管理 API 對接，例如狀態查詢與 snapshot rebuild

下一步應該是繼續把剩餘的特殊流程也收進 repository，例如：

- 預設資料初始化
- recurring 套用
- legacy 資料清理
- 匯入與批次更新流程

到那一步之後，`app.js` 會更接近純 UI / 業務流程層，也比較容易對接 SQLite backend。
