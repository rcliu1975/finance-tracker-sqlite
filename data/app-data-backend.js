import { createFirebaseDataBackend } from "./firebase-data-backend.js";

export function createAppDataBackend(options) {
  return createFirebaseDataBackend(options);
}
