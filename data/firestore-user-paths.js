import { collection, doc } from "./firebase-backend.js";

export function userCollectionRef(db, uid, name) {
  return collection(db, "users", uid, name);
}

export function userDocumentRef(db, uid, collectionName, id) {
  return doc(db, "users", uid, collectionName, id);
}

export function userMetaRef(db, uid, key) {
  return doc(db, "users", uid, "meta", key);
}

export function userMonthlySnapshotRef(db, uid, month) {
  return doc(db, "users", uid, "monthlySnapshots", month);
}
