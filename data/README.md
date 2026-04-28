# Data Layer Notes

這個目錄先放 `finance-tracker-sqlite` 的資料層切分。

目前分工：

- `firebase-backend.js`
  集中 Firebase SDK import、`firebase-config.js` 載入，以及 Firestore / Auth 初始化。
- `firestore-user-paths.js`
  集中 `users/{uid}/...` 文件與集合路徑 helper。

目前還沒有做到完整 repository abstraction，但至少先把兩件事從 `app.js` 拆出去：

1. SDK 依賴來源
2. Firestore 路徑結構

下一步應該是把 CRUD / query 的實際讀寫流程再往上抽一層，例如：

- `loadSettings`
- `loadReferenceData`
- `saveTransaction`
- `deleteTransaction`
- `saveAccount`
- `saveCategory`

到那一步之後，`app.js` 才能開始真正不感知 Firestore，並為 SQLite backend 留出可替換介面。
