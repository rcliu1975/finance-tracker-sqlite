// 建議改用 .env 搭配 scripts/generate-app-config.js 產生 app-config.js。
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export const firebaseRuntime = {
  useEmulators: false,
  emulatorHost: "",
  authEmulatorPort: 9099,
  firestoreEmulatorPort: 8080,
  emulatorUiPort: 4000
};

export const appRuntime = {
  storageBackend: "firebase",
  localUserId: "local-user",
  sqliteSeedPath: "",
  sqliteApiBaseUrl: ""
};
