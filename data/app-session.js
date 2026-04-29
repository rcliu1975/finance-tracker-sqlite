import { loadAppRuntime } from "./app-runtime.js";
import { createAppDataBackend } from "./app-data-backend.js";

export async function initializeAppSession() {
  const runtime = await loadAppRuntime();
  const {
    db,
    bootstrapError,
    bootstrapErrorMessage,
    hasConfig,
    initialData,
    localStorageKey,
    modeNotice,
    providerLabel
  } = runtime;
  const waitingStatus = `等待 ${providerLabel} 連線`;
  const dataBackend = createAppDataBackend({
    getDb: () => db,
    getUid: () => null,
    initialData,
    storageKey: localStorageKey,
    apiBaseUrl: runtime.sqliteApiBaseUrl,
    providerKey: runtime.providerKey
  });
  return {
    runtime,
    dataBackend,
    bootstrapError,
    bootstrapErrorMessage,
    hasConfig,
    initialData,
    modeNotice,
    providerLabel,
    waitingStatus
  };
}

export function applySessionBootstrapState({
  hasConfig,
  waitingStatus,
  bootstrapError,
  bootstrapErrorMessage,
  modeNotice,
  setStatus,
  setError
}) {
  if (hasConfig) {
    setStatus(waitingStatus);
  }
  if (bootstrapError && bootstrapErrorMessage) {
    setError(bootstrapErrorMessage);
  }
  if (modeNotice) {
    setError((currentError) => [currentError, modeNotice].filter(Boolean).join(" "));
  }
}

