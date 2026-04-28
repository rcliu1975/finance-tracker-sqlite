import {
  createUserWithEmailAndPassword,
  initializeFirebaseServices,
  loadFirebaseBootstrap,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "./firebase-backend.js";

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
    return {
      db: null,
      auth: null,
      bootstrapError: loadError,
      hasConfig: !loadError,
      configFileName: "firebase-config.js",
      providerKey,
      providerLabel: "SQLite",
      modeNotice: "目前使用本機記憶體版 SQLite backend，重新整理頁面後資料不保留。",
      supportsEmailAuth: false,
      supportsSignOut: false,
      observeAuthState(callback) {
        queueMicrotask(() => {
          callback(localUser);
        });
        return () => {};
      },
      registerWithEmail() {
        return Promise.reject(new Error("SQLite 本機模式目前不支援 Email 註冊。"));
      },
      signInWithEmail() {
        return Promise.reject(new Error("SQLite 本機模式目前不支援 Email 登入。"));
      },
      signOut() {
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
    hasConfig: Boolean(firebaseConfig),
    configFileName: "firebase-config.js",
    providerKey,
    providerLabel: "Firebase",
    modeNotice: "",
    supportsEmailAuth: true,
    supportsSignOut: true,
    observeAuthState(callback) {
      if (!auth) {
        return () => {};
      }
      return onAuthStateChanged(auth, callback);
    },
    registerWithEmail(email, password) {
      return createUserWithEmailAndPassword(auth, email, password);
    },
    signInWithEmail(email, password) {
      return signInWithEmailAndPassword(auth, email, password);
    },
    signOut() {
      return signOut(auth);
    }
  };
}
