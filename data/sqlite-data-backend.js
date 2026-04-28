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

export function createSQLiteDataBackend() {
  const collections = createCollectionState();
  let settings = null;
  let nextId = 1;

  function requireCollection(name) {
    if (!Object.prototype.hasOwnProperty.call(collections, name)) {
      throw new Error(`SQLite backend stub 不支援集合：${name}`);
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
      settings = cloneValue(payload);
    },
    async saveSettingsPatch(payload) {
      settings = {
        ...(settings || {}),
        ...cloneValue(payload)
      };
    },
    async createUserCollectionDocument(collectionName, payload) {
      const items = requireCollection(collectionName);
      const id = nextDocumentId(collectionName);
      items.push({ id, ...cloneValue(payload) });
      return { id };
    },
    async saveUserCollectionDocument(collectionName, id, payload) {
      const items = requireCollection(collectionName);
      const nextDocument = { id, ...cloneValue(payload) };
      const index = findDocumentIndex(items, id);
      if (index < 0) {
        items.push(nextDocument);
        return;
      }
      items[index] = nextDocument;
    },
    async updateUserCollectionDocument(collectionName, id, payload) {
      const items = requireCollection(collectionName);
      const index = findDocumentIndex(items, id);
      if (index < 0) {
        throw new Error(`SQLite backend stub 找不到文件：${collectionName}/${id}`);
      }
      items[index] = {
        ...items[index],
        ...cloneValue(payload)
      };
    },
    async deleteUserCollectionDocument(collectionName, id) {
      const items = requireCollection(collectionName);
      const index = findDocumentIndex(items, id);
      if (index >= 0) {
        items.splice(index, 1);
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
