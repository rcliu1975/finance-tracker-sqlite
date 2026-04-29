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

function buildApiUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });
  return url;
}

async function requestApiJson(baseUrl, path, { method = "GET", params = {}, body } = {}) {
  const response = await fetch(buildApiUrl(baseUrl, path, params), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function createSQLiteHttpBackend(options = {}) {
  const baseUrl = String(options.apiBaseUrl || "").trim();
  if (!baseUrl) {
    throw new Error("缺少 SQLite API base URL。");
  }

  return {
    async loadCollectionItems(name) {
      return requestApiJson(baseUrl, `collection/${name}`);
    },
    async loadHistoryMetadata() {
      return requestApiJson(baseUrl, "history-metadata");
    },
    async loadLatestSnapshotBeforeMonth(month) {
      return requestApiJson(baseUrl, `snapshots/latest-before/${month}`);
    },
    async loadReferenceData() {
      return requestApiJson(baseUrl, "reference-data");
    },
    async loadSettingsState() {
      return requestApiJson(baseUrl, "settings/state");
    },
    async loadSnapshotByMonth(month) {
      return requestApiJson(baseUrl, `snapshots/${month}`);
    },
    async loadStoredSettingsState() {
      return requestApiJson(baseUrl, "settings/state");
    },
    async loadTransactionsByDateRange(startDate = "", endDate = "") {
      return requestApiJson(baseUrl, "transactions", {
        params: { startDate, endDate }
      });
    },
    async replaceSettingsState(payload) {
      await requestApiJson(baseUrl, "settings/replace", {
        method: "POST",
        body: payload
      });
    },
    async saveSettingsPatch(payload) {
      await requestApiJson(baseUrl, "settings/patch", {
        method: "PATCH",
        body: payload
      });
    },
    async createUserCollectionDocument(collectionName, payload) {
      return requestApiJson(baseUrl, `collection/${collectionName}`, {
        method: "POST",
        body: payload
      });
    },
    async saveUserCollectionDocument(collectionName, id, payload) {
      await requestApiJson(baseUrl, `collection/${collectionName}/${id}`, {
        method: "PUT",
        body: payload
      });
    },
    async updateUserCollectionDocument(collectionName, id, payload) {
      await requestApiJson(baseUrl, `collection/${collectionName}/${id}`, {
        method: "PATCH",
        body: payload
      });
    },
    async deleteUserCollectionDocument(collectionName, id) {
      await requestApiJson(baseUrl, `collection/${collectionName}/${id}`, {
        method: "DELETE"
      });
    },
    async batchUpdateUserCollectionOrders(items) {
      await requestApiJson(baseUrl, "batch-update-orders", {
        method: "POST",
        body: { items }
      });
    }
  };
}

export function createSQLiteDataBackend(options = {}) {
  if (options.apiBaseUrl) {
    return createSQLiteHttpBackend(options);
  }
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
