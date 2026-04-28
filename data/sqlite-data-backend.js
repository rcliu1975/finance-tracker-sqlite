function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function monthKey(dateText) {
  return String(dateText || "").slice(0, 7);
}

function createCollectionState() {
  return {
    accounts: [],
    categories: [],
    recurring: [],
    transactions: [],
    monthlySnapshots: []
  };
}

function defaultSettings() {
  return {
    monthlyBudget: 0,
    recurringAppliedMonth: "",
    snapshotDirtyFromMonth: "",
    legacyTransactionsCheckedAt: 0
  };
}

function normalizeSeedData(seedData) {
  const collections = createCollectionState();
  const sourceCollections = seedData?.collections || {};
  for (const name of Object.keys(collections)) {
    collections[name] = Array.isArray(sourceCollections[name]) ? cloneValue(sourceCollections[name]) : [];
  }
  return {
    settings: {
      ...defaultSettings(),
      ...(seedData?.settings && typeof seedData.settings === "object" ? cloneValue(seedData.settings) : {})
    },
    collections,
    commonSummaries:
      seedData?.commonSummaries && typeof seedData.commonSummaries === "object" ? cloneValue(seedData.commonSummaries) : {},
    nextId: Number(seedData?.nextId || 1) > 0 ? Number(seedData?.nextId || 1) : 1
  };
}

function readLocalSnapshot(storageKey) {
  if (!storageKey || !globalThis.localStorage) {
    return null;
  }
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocalSnapshot(storageKey, snapshot) {
  if (!storageKey || !globalThis.localStorage) {
    return;
  }
  globalThis.localStorage.setItem(storageKey, JSON.stringify(snapshot));
}

export function createSQLiteDataBackend(options = {}) {
  const normalizedSeed = normalizeSeedData(options.initialData);
  const storageKey = String(options.storageKey || "").trim();
  const persistedSnapshot = readLocalSnapshot(storageKey);
  const persisted = normalizeSeedData(persistedSnapshot);
  const shouldUsePersisted = Boolean(persistedSnapshot);
  const active = shouldUsePersisted ? persisted : normalizedSeed;
  const collections = active.collections;
  let settings = active.settings;
  let nextId = active.nextId;

  function persist() {
    writeLocalSnapshot(storageKey, {
      settings,
      collections,
      commonSummaries: normalizedSeed.commonSummaries,
      nextId
    });
  }

  if (!shouldUsePersisted && storageKey) {
    persist();
  }

  function requireCollection(name) {
    if (!Object.prototype.hasOwnProperty.call(collections, name)) {
      throw new Error(`SQLite backend 不支援集合：${name}`);
    }
    return collections[name];
  }

  function nextDocumentId(collectionName) {
    const safeName = String(collectionName || "doc").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const id = `${safeName}-${String(nextId).padStart(6, "0")}`;
    nextId += 1;
    return id;
  }

  function findDocumentIndex(items, id) {
    return items.findIndex((item) => item.id === id);
  }

  function sortedItems(items, orderField = "") {
    const cloned = items.map((item) => cloneValue(item));
    if (!orderField) {
      return cloned;
    }
    return cloned.sort((left, right) => {
      const leftValue = left?.[orderField];
      const rightValue = right?.[orderField];
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return rightValue - leftValue;
      }
      return compareText(rightValue, leftValue);
    });
  }

  return {
    async loadCollectionItems(name, orderField = "") {
      return sortedItems(requireCollection(name), orderField);
    },
    async loadHistoryMetadata() {
      const transactions = requireCollection("transactions");
      const monthlySnapshots = requireCollection("monthlySnapshots");
      const earliestTransactionMonth = transactions
        .map((item) => monthKey(item.date))
        .filter(Boolean)
        .sort()[0] || "";
      const earliestSnapshotMonth = monthlySnapshots
        .map((item) => String(item.month || "").trim())
        .filter(Boolean)
        .sort()[0] || "";
      return {
        hasTransactions: transactions.length > 0,
        earliestTransactionMonth,
        earliestSnapshotMonth
      };
    },
    async loadLatestSnapshotBeforeMonth(month) {
      const snapshots = requireCollection("monthlySnapshots")
        .filter((item) => String(item.month || "") < String(month || ""))
        .sort((left, right) => compareText(right.month, left.month));
      return snapshots[0] ? cloneValue(snapshots[0]) : null;
    },
    async loadReferenceData() {
      return {
        accounts: await this.loadCollectionItems("accounts"),
        categories: await this.loadCollectionItems("categories"),
        recurring: await this.loadCollectionItems("recurring")
      };
    },
    async loadSettingsState() {
      return settings ? cloneValue(settings) : {};
    },
    async loadSnapshotByMonth(month) {
      const snapshot = requireCollection("monthlySnapshots").find((item) => item.month === month);
      return snapshot ? cloneValue(snapshot) : null;
    },
    async loadStoredSettingsState() {
      return settings ? cloneValue(settings) : null;
    },
    async loadTransactionsByDateRange(startDate = "", endDate = "") {
      return requireCollection("transactions")
        .filter((item) => (!startDate || item.date >= startDate) && (!endDate || item.date <= endDate))
        .sort((left, right) => compareText(right.date, left.date))
        .map((item) => cloneValue(item));
    },
    async replaceSettingsState(payload) {
      settings = {
        ...defaultSettings(),
        ...cloneValue(payload)
      };
      persist();
    },
    async saveSettingsPatch(payload) {
      settings = {
        ...(settings || {}),
        ...cloneValue(payload)
      };
      persist();
    },
    async createUserCollectionDocument(collectionName, payload) {
      const items = requireCollection(collectionName);
      const id = nextDocumentId(collectionName);
      items.push({ id, ...cloneValue(payload) });
      persist();
      return { id };
    },
    async saveUserCollectionDocument(collectionName, id, payload) {
      const items = requireCollection(collectionName);
      const nextDocument = { id, ...cloneValue(payload) };
      const index = findDocumentIndex(items, id);
      if (index < 0) {
        items.push(nextDocument);
        persist();
        return;
      }
      items[index] = nextDocument;
      persist();
    },
    async updateUserCollectionDocument(collectionName, id, payload) {
      const items = requireCollection(collectionName);
      const index = findDocumentIndex(items, id);
      if (index < 0) {
        throw new Error(`SQLite backend 找不到文件：${collectionName}/${id}`);
      }
      items[index] = {
        ...items[index],
        ...cloneValue(payload)
      };
      persist();
    },
    async deleteUserCollectionDocument(collectionName, id) {
      const items = requireCollection(collectionName);
      const index = findDocumentIndex(items, id);
      if (index >= 0) {
        items.splice(index, 1);
        persist();
      }
    },
    async batchUpdateUserCollectionOrders(items) {
      for (const item of items) {
        await this.updateUserCollectionDocument(item.collection, item.id, {
          order: item.order
        });
      }
    }
  };
}
