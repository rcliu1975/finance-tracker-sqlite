import {
  createUserWithEmailAndPassword,
  initializeFirebaseServices,
  loadFirebaseBootstrap,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "./firebase-backend.js";

export async function loadAppRuntime() {
  const { firebaseConfig, firebaseRuntime, loadError } = await loadFirebaseBootstrap();
  const services = firebaseConfig ? initializeFirebaseServices(firebaseConfig, firebaseRuntime) || {} : {};
  const auth = services.auth || null;
  const db = services.db || null;

  return {
    db,
    auth,
    bootstrapError: loadError,
    hasConfig: Boolean(firebaseConfig),
    configFileName: "firebase-config.js",
    providerLabel: "Firebase",
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
