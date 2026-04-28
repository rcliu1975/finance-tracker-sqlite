import {
  batchUpdateUserCollectionOrders,
  createUserCollectionDocument,
  deleteUserCollectionDocument,
  loadCollectionItems,
  loadHistoryMetadata,
  loadLatestSnapshotBeforeMonth,
  loadReferenceData,
  loadSettingsState,
  loadSnapshotByMonth,
  loadStoredSettingsState,
  loadTransactionsByDateRange,
  replaceSettingsState,
  saveSettingsPatch,
  saveUserCollectionDocument,
  updateUserCollectionDocument
} from "./firebase-repository.js";

export function createFirebaseDataBackend({ getDb, getUid }) {
  function requireDb() {
    return getDb();
  }

  function requireUid() {
    return getUid();
  }

  return {
    loadCollectionItems(name, orderField = "") {
      return loadCollectionItems(requireDb(), requireUid(), name, orderField);
    },
    loadHistoryMetadata() {
      return loadHistoryMetadata(requireDb(), requireUid());
    },
    loadLatestSnapshotBeforeMonth(month) {
      return loadLatestSnapshotBeforeMonth(requireDb(), requireUid(), month);
    },
    loadReferenceData() {
      return loadReferenceData(requireDb(), requireUid());
    },
    loadSettingsState() {
      return loadSettingsState(requireDb(), requireUid());
    },
    loadSnapshotByMonth(month) {
      return loadSnapshotByMonth(requireDb(), requireUid(), month);
    },
    loadStoredSettingsState() {
      return loadStoredSettingsState(requireDb(), requireUid());
    },
    loadTransactionsByDateRange(startDate = "", endDate = "") {
      return loadTransactionsByDateRange(requireDb(), requireUid(), startDate, endDate);
    },
    replaceSettingsState(payload) {
      return replaceSettingsState(requireDb(), requireUid(), payload);
    },
    saveSettingsPatch(payload) {
      return saveSettingsPatch(requireDb(), requireUid(), payload);
    },
    createUserCollectionDocument(collectionName, payload) {
      return createUserCollectionDocument(requireDb(), requireUid(), collectionName, payload);
    },
    saveUserCollectionDocument(collectionName, id, payload) {
      return saveUserCollectionDocument(requireDb(), requireUid(), collectionName, id, payload);
    },
    updateUserCollectionDocument(collectionName, id, payload) {
      return updateUserCollectionDocument(requireDb(), requireUid(), collectionName, id, payload);
    },
    deleteUserCollectionDocument(collectionName, id) {
      return deleteUserCollectionDocument(requireDb(), requireUid(), collectionName, id);
    },
    batchUpdateUserCollectionOrders(items) {
      return batchUpdateUserCollectionOrders(requireDb(), requireUid(), items);
    }
  };
}
