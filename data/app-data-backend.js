import { createFirebaseDataBackend } from "./firebase-data-backend.js";
import { createSQLiteDataBackend } from "./sqlite-data-backend.js";

export function createAppDataBackend(options) {
  const providerKey = String(options?.providerKey || "firebase").trim().toLowerCase() || "firebase";
  if (providerKey === "sqlite") {
    return createSQLiteDataBackend(options);
  }
  if (providerKey === "firebase") {
    return createFirebaseDataBackend(options);
  }
  throw new Error(`不支援的資料 backend：${providerKey}`);
}
