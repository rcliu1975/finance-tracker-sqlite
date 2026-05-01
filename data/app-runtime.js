const SQLITE_BRIDGE_SESSION_KEY = "financeTrackerSqliteBridgeSession:v1";

async function loadAppBootstrap() {
  try {
    const { appRuntime = {}, firebaseConfig = null, firebaseRuntime = {} } = await import("../app-config.js");
    return { appRuntime, firebaseConfig, firebaseRuntime, loadError: null };
  } catch (loadError) {
    try {
      const { appRuntime = {}, firebaseConfig = null, firebaseRuntime = {} } = await import("../firebase-config.js");
      return { appRuntime, firebaseConfig, firebaseRuntime, loadError: null };
    } catch (legacyLoadError) {
      return { appRuntime: {}, firebaseConfig: null, firebaseRuntime: {}, loadError: legacyLoadError || loadError };
    }
  }
}

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

async function requestBridgeSessionJson(baseUrl, path, { method = "GET", body, token = "" } = {}) {
  const headers = {};
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`), {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function readStoredSQLiteBridgeSession(storageKey) {
  const storage = globalThis.sessionStorage || globalThis.localStorage;
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    storage.removeItem(storageKey);
    return {};
  }
}

function writeStoredSQLiteBridgeSession(storageKey, payload) {
  const storage = globalThis.sessionStorage || globalThis.localStorage;
  if (!storage) {
    return;
  }
  if (!payload || !Object.keys(payload).length) {
    storage.removeItem(storageKey);
    return;
  }
  storage.setItem(storageKey, JSON.stringify(payload));
}

export async function loadAppRuntime() {
  const { appRuntime: runtimeConfig = {}, firebaseConfig, firebaseRuntime, loadError } = await loadAppBootstrap();
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
    const bridgeSessionStorageKey = `${SQLITE_BRIDGE_SESSION_KEY}:${sqliteApiBaseUrl || localUserId}`;
    let initialData = null;
    let bootstrapError = loadError;
    let currentBridgeSession = readStoredSQLiteBridgeSession(bridgeSessionStorageKey);
    const sqliteSessionObservers = new Set();

    async function loadSQLiteBridgeSessionConfig() {
      if (!sqliteApiBaseUrl) {
        return {
          supportsCredentialSession: false
        };
      }
      return requestBridgeSessionJson(sqliteApiBaseUrl, "session/config");
    }

    function notifySQLiteSessionObservers(user) {
      sqliteSessionObservers.forEach((callback) => {
        try {
          callback(user);
        } catch (observerError) {
          console.error(observerError);
        }
      });
    }

    async function loadSQLiteBridgeCurrentUser() {
      const accessToken = String(currentBridgeSession?.token || "").trim();
      if (!sqliteApiBaseUrl || !accessToken) {
        return null;
      }
      try {
        const payload = await requestBridgeSessionJson(sqliteApiBaseUrl, "session/me", {
          token: accessToken
        });
        currentBridgeSession = {
          token: accessToken,
          user: payload.user || null
        };
        writeStoredSQLiteBridgeSession(bridgeSessionStorageKey, currentBridgeSession);
        return currentBridgeSession.user || null;
      } catch {
        currentBridgeSession = {};
        writeStoredSQLiteBridgeSession(bridgeSessionStorageKey, {});
        return null;
      }
    }

    const sqliteSessionConfig = await loadSQLiteBridgeSessionConfig().catch((error) => {
      bootstrapError = bootstrapError || error;
      return {
        supportsCredentialSession: false
      };
    });
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
      getAccessToken() {
        return String(currentBridgeSession?.token || "").trim();
      },
      modeNotice: sqliteApiBaseUrl
        ? sqliteSessionConfig.supportsCredentialSession
          ? `目前使用 SQLite HTTP bridge（帳密登入模式）：${sqliteApiBaseUrl}`
          : `目前使用 SQLite HTTP bridge：${sqliteApiBaseUrl}`
        : sqliteSeedPath
        ? "目前使用 SQLite seed + localStorage 模式。初次載入會讀取 seed，之後修改會保存在目前瀏覽器。"
        : "目前使用本機記憶體版 SQLite backend，重新整理頁面後資料不保留。",
      supportsCredentialSession: Boolean(sqliteSessionConfig.supportsCredentialSession),
      supportsCredentialRegistration: false,
      supportsSessionSignOut: Boolean(sqliteSessionConfig.supportsCredentialSession),
      observeSessionState(callback) {
        sqliteSessionObservers.add(callback);
        queueMicrotask(async () => {
          if (sqliteSessionConfig.supportsCredentialSession) {
            callback((await loadSQLiteBridgeCurrentUser()) || null);
            return;
          }
          callback(localUser);
        });
        return () => sqliteSessionObservers.delete(callback);
      },
      async registerWithCredentials(email, password) {
        if (!sqliteSessionConfig.supportsCredentialSession) {
          return Promise.reject(new Error("SQLite 本機模式目前不支援 Email 註冊。"));
        }
        const payload = await requestBridgeSessionJson(sqliteApiBaseUrl, "session/login", {
          method: "POST",
          body: { email, password }
        });
        currentBridgeSession = {
          token: String(payload.token || ""),
          user: payload.user || null
        };
        writeStoredSQLiteBridgeSession(bridgeSessionStorageKey, currentBridgeSession);
        notifySQLiteSessionObservers(currentBridgeSession.user || null);
        return payload.user || null;
      },
      async signInWithCredentials(email, password) {
        if (!sqliteSessionConfig.supportsCredentialSession) {
          return Promise.reject(new Error("SQLite 本機模式目前不支援 Email 登入。"));
        }
        const payload = await requestBridgeSessionJson(sqliteApiBaseUrl, "session/login", {
          method: "POST",
          body: { email, password }
        });
        currentBridgeSession = {
          token: String(payload.token || ""),
          user: payload.user || null
        };
        writeStoredSQLiteBridgeSession(bridgeSessionStorageKey, currentBridgeSession);
        notifySQLiteSessionObservers(currentBridgeSession.user || null);
        return payload.user || null;
      },
      async signOutSession() {
        if (sqliteSessionConfig.supportsCredentialSession && currentBridgeSession?.token) {
          try {
            await requestBridgeSessionJson(sqliteApiBaseUrl, "session/logout", {
              method: "POST",
              token: String(currentBridgeSession.token || "")
            });
          } catch {
            // Ignore transport failures and still clear local session.
          }
          currentBridgeSession = {};
          writeStoredSQLiteBridgeSession(bridgeSessionStorageKey, {});
          notifySQLiteSessionObservers(null);
        }
        return Promise.resolve();
      }
    };
  }

  const {
    createUserWithEmailAndPassword,
    initializeFirebaseServices,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut
  } = await import("./firebase-backend.js");
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
    supportsCredentialRegistration: true,
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
