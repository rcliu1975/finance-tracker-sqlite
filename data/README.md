# Data Layer Notes

這個目錄先放 `finance-tracker-sqlite` 的資料層切分。

目前分工：

- `firebase-backend.js`
  集中 Firebase SDK import、`firebase-config.js` 載入，以及 Firestore / Auth 初始化。
- `firestore-user-paths.js`
  集中 `users/{uid}/...` 文件與集合路徑 helper。

目前已經有初步的 repository abstraction，先把下列責任從 `app.js` 抽出去：

1. SDK 依賴來源
2. Firestore 路徑結構
3. 主要讀取 query
4. 交易、設定與項目管理的核心寫入 API

下一步應該是繼續把剩餘的特殊流程也收進 repository，例如：

- 預設資料初始化
- recurring 套用
- legacy 資料清理
- 匯入與批次更新流程

到那一步之後，`app.js` 會更接近純 UI / 業務流程層，也比較容易對接 SQLite backend。
