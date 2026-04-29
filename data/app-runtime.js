import {
  createUserWithEmailAndPassword,
  initializeFirebaseServices,
  loadFirebaseBootstrap,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "./firebase-backend.js";

async function loadSQLiteSeedData(seedPath) {
  const path = String(seedPath || "").trim();
  if (!path) {
    return null;
  }
  const response = await fetch(path, {
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`無法載入 SQLite seed：${path} (${response.status})`);
  }
  return response.json();
}

export async function loadAppRuntime() {
  const { appRuntime: runtimeConfig = {}, firebaseConfig, firebaseRuntime, loadError } = await loadFirebaseBootstrap();
  const providerKey = String(runtimeConfig.storageBackend || "firebase").trim().toLowerCase() || "firebase";
  const localUserId = String(runtimeConfig.localUserId || "local-user").trim() || "local-user";
  if (providerKey === "sqlite") {
    const localUser = {
      uid: localUserId,
      email: "",
      displayName: "SQLite 本機模式",
      isLocalUser: true
    };
    const sqliteSeedPath = String(runtimeConfig.sqliteSeedPath || "").trim();
    const sqliteApiBaseUrl = String(runtimeConfig.sqliteApiBaseUrl || "").trim();
    let initialData = null;
    let bootstrapError = loadError;
    if (sqliteApiBaseUrl) {
      initialData = null;
    } else if (sqliteSeedPath) {
      try {
        initialData = await loadSQLiteSeedData(sqliteSeedPath);
      } catch (seedLoadError) {
        bootstrapError = seedLoadError;
      }
    }
    const bootstrapErrorMessage = loadError
      ? "找不到 app-config.js 或 firebase-config.js，請先完成設定。"
      : bootstrapError
        ? `SQLite seed 載入失敗：${bootstrapError.message || bootstrapError}`
        : "";
    return {
      db: null,
      auth: null,
      bootstrapError,
      bootstrapErrorMessage,
      hasConfig: !loadError,
      configFileName: "app-config.js",
      initialData,
      localStorageKey: sqliteApiBaseUrl ? "" : `financeTrackerSqliteBackend:${localUserId}`,
      sqliteApiBaseUrl,
      providerKey,
      providerLabel: "SQLite",
      modeNotice: sqliteApiBaseUrl
        ? `目前使用 SQLite HTTP bridge：${sqliteApiBaseUrl}`
        : sqliteSeedPath
        ? "目前使用 SQLite seed + localStorage 模式。初次載入會讀取 seed，之後修改會保存在目前瀏覽器。"
        : "目前使用本機記憶體版 SQLite backend，重新整理頁面後資料不保留。",
      supportsCredentialSession: false,
      supportsSessionSignOut: false,
      observeSessionState(callback) {
        queueMicrotask(() => {
          callback(localUser);
        });
        return () => {};
      },
      registerWithCredentials() {
        return Promise.reject(new Error("SQLite 本機模式目前不支援 Email 註冊。"));
      },
      signInWithCredentials() {
        return Promise.reject(new Error("SQLite 本機模式目前不支援 Email 登入。"));
      },
      signOutSession() {
        return Promise.resolve();
      }
    };
  }

  const services = firebaseConfig ? initializeFirebaseServices(firebaseConfig, firebaseRuntime) || {} : {};
  const auth = services.auth || null;
  const db = services.db || null;

  return {
    db,
    auth,
    bootstrapError: loadError,
    bootstrapErrorMessage: loadError ? "找不到 app-config.js 或 firebase-config.js，請先完成設定。" : "",
    hasConfig: Boolean(firebaseConfig),
    configFileName: "app-config.js",
    initialData: null,
    localStorageKey: "",
    providerKey,
    providerLabel: "Firebase",
    modeNotice: "",
    supportsCredentialSession: true,
    supportsSessionSignOut: true,
    observeSessionState(callback) {
      if (!auth) {
        return () => {};
      }
      return onAuthStateChanged(auth, callback);
    },
    registerWithCredentials(email, password) {
      return createUserWithEmailAndPassword(auth, email, password);
    },
    signInWithCredentials(email, password) {
      return signInWithEmailAndPassword(auth, email, password);
    },
    signOutSession() {
      return signOut(auth);
    }
  };
}
