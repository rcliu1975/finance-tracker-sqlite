import { addDoc, deleteDoc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where } from "./firebase-backend.js";
import { userCollectionRef, userDocumentRef, userMetaRef, userMonthlySnapshotRef } from "./firestore-user-paths.js";

function monthKey(dateText) {
  return String(dateText || "").slice(0, 7);
}

function collectionPath(db, uid, name) {
  return userCollectionRef(db, uid, name);
}

function documentPath(db, uid, collectionName, id) {
  return userDocumentRef(db, uid, collectionName, id);
}

export async function loadCollectionItems(db, uid, name, orderField = "") {
  const reference = orderField ? query(collectionPath(db, uid, name), orderBy(orderField, "desc")) : collectionPath(db, uid, name);
  const snap = await getDocs(reference);
  return snap.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function loadSettingsState(db, uid) {
  const settingsRef = userMetaRef(db, uid, "settings");
  const settingsSnap = await getDoc(settingsRef);
  return settingsSnap.exists() ? settingsSnap.data() || {} : {};
}

export async function loadReferenceData(db, uid) {
  const [accounts, categories, recurring] = await Promise.all([
    loadCollectionItems(db, uid, "accounts"),
    loadCollectionItems(db, uid, "categories"),
    loadCollectionItems(db, uid, "recurring"),
  ]);
  return { accounts, categories, recurring };
}

export async function hasAnyTransactionsInStore(db, uid) {
  const snap = await getDocs(query(collectionPath(db, uid, "transactions"), orderBy("date", "desc"), limit(1)));
  return !snap.empty;
}

export async function getEarliestTransactionMonthInStore(db, uid) {
  const snap = await getDocs(query(collectionPath(db, uid, "transactions"), orderBy("date", "asc"), limit(1)));
  if (snap.empty) {
    return "";
  }
  return monthKey(snap.docs[0].data()?.date || "");
}

export async function getEarliestSnapshotMonthInStore(db, uid) {
  const snap = await getDocs(query(collectionPath(db, uid, "monthlySnapshots"), orderBy("month", "asc"), limit(1)));
  if (snap.empty) {
    return "";
  }
  return String(snap.docs[0].data()?.month || "").trim();
}

export async function loadHistoryMetadata(db, uid) {
  const [hasTransactions, earliestTransactionMonth, earliestSnapshotMonth] = await Promise.all([
    hasAnyTransactionsInStore(db, uid),
    getEarliestTransactionMonthInStore(db, uid),
    getEarliestSnapshotMonthInStore(db, uid),
  ]);
  return { hasTransactions, earliestTransactionMonth, earliestSnapshotMonth };
}

export async function loadSnapshotByMonth(db, uid, month) {
  const snapshot = await getDoc(userMonthlySnapshotRef(db, uid, month));
  if (!snapshot.exists()) {
    return null;
  }
  return { id: snapshot.id, ...snapshot.data() };
}

export async function loadLatestSnapshotBeforeMonth(db, uid, month) {
  const snap = await getDocs(
    query(collectionPath(db, uid, "monthlySnapshots"), where("month", "<", month), orderBy("month", "desc"), limit(1))
  );
  if (snap.empty) {
    return null;
  }
  const snapshot = snap.docs[0];
  return { id: snapshot.id, ...snapshot.data() };
}

export async function loadTransactionsByDateRange(db, uid, startDate = "", endDate = "") {
  const constraints = [];
  if (startDate) {
    constraints.push(where("date", ">=", startDate));
  }
  if (endDate) {
    constraints.push(where("date", "<=", endDate));
  }
  constraints.push(orderBy("date", "desc"));
  const snap = await getDocs(query(collectionPath(db, uid, "transactions"), ...constraints));
  return snap.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export function replaceSettingsState(db, uid, payload) {
  return setDoc(userMetaRef(db, uid, "settings"), payload);
}

export function saveSettingsPatch(db, uid, payload) {
  return updateDoc(userMetaRef(db, uid, "settings"), payload);
}

export function createUserCollectionDocument(db, uid, collectionName, payload) {
  return addDoc(collectionPath(db, uid, collectionName), payload);
}

export function saveUserCollectionDocument(db, uid, collectionName, id, payload) {
  return setDoc(documentPath(db, uid, collectionName, id), payload);
}

export function updateUserCollectionDocument(db, uid, collectionName, id, payload) {
  return updateDoc(documentPath(db, uid, collectionName, id), payload);
}

export function deleteUserCollectionDocument(db, uid, collectionName, id) {
  return deleteDoc(documentPath(db, uid, collectionName, id));
}

export function batchUpdateUserCollectionOrders(db, uid, items) {
  return Promise.all(
    items.map((item) =>
      updateUserCollectionDocument(db, uid, item.collection, item.id, {
        order: item.order
      })
    )
  );
}
