import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export {
  addDoc,
  collection,
  createUserWithEmailAndPassword,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onAuthStateChanged,
  orderBy,
  query,
  setDoc,
  signInWithEmailAndPassword,
  signOut,
  updateDoc,
  where
};

export async function loadFirebaseBootstrap() {
  try {
    const { appRuntime = {}, firebaseConfig = null, firebaseRuntime = {} } = await import("../firebase-config.js");
    return { appRuntime, firebaseConfig, firebaseRuntime, loadError: null };
  } catch (loadError) {
    return { appRuntime: {}, firebaseConfig: null, firebaseRuntime: {}, loadError };
  }
}

export function getFirebaseRuntimeConfig(firebaseRuntime) {
  const runtime = firebaseRuntime || {};
  const emulatorHost = String(runtime.emulatorHost || "").trim() || window.location.hostname || "127.0.0.1";
  return {
    useEmulators: Boolean(runtime.useEmulators),
    emulatorHost,
    authEmulatorPort: Number(runtime.authEmulatorPort || 9099),
    firestoreEmulatorPort: Number(runtime.firestoreEmulatorPort || 8080),
    emulatorUiPort: Number(runtime.emulatorUiPort || 4000)
  };
}

export function initializeFirebaseServices(firebaseConfig, firebaseRuntime) {
  if (!firebaseConfig) {
    return null;
  }

  const app = initializeApp(firebaseConfig);
  const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false
  });
  const auth = getAuth(app);
  const runtime = getFirebaseRuntimeConfig(firebaseRuntime);

  if (runtime.useEmulators) {
    connectFirestoreEmulator(db, runtime.emulatorHost, runtime.firestoreEmulatorPort);
    connectAuthEmulator(auth, `http://${runtime.emulatorHost}:${runtime.authEmulatorPort}`, {
      disableWarnings: true
    });
  }

  return { app, db, auth, runtime };
}
