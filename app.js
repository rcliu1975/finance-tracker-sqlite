import {
  createUserWithEmailAndPassword,
  getDoc,
  getDocs,
  initializeFirebaseServices,
  loadFirebaseBootstrap,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "./data/firebase-backend.js";
import { userCollectionRef, userMetaRef } from "./data/firestore-user-paths.js";
import {
  batchUpdateUserCollectionOrders,
  createUserCollectionDocument,
  deleteUserCollectionDocument,
  loadHistoryMetadata,
  loadLatestSnapshotBeforeMonth,
  loadReferenceData,
  loadSettingsState,
  loadSnapshotByMonth,
  loadTransactionsByDateRange,
  replaceSettingsState,
  saveSettingsPatch,
  saveUserCollectionDocument,
  updateUserCollectionDocument
} from "./data/firebase-repository.js";

let authInitialized = false;
const COMMON_SUMMARY_STORAGE_KEY = "financeCommonSummaries:v2";

window.addEventListener("error", (event) => {
  const message = event.error?.message || event.message || "未知錯誤";
  const status = document.getElementById("authStatus");
  const authError = document.getElementById("authError");
  if (status) {
    status.textContent = "前端初始化失敗";
  }
  if (authError) {
    authError.textContent = `初始化錯誤：${message}`;
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || event.reason?.code || String(event.reason || "未知錯誤");
  const status = document.getElementById("authStatus");
  const authError = document.getElementById("authError");
  if (status) {
    status.textContent = "前端初始化失敗";
  }
  if (authError) {
    authError.textContent = `初始化錯誤：${reason}`;
  }
});

const { firebaseConfig, firebaseRuntime, loadError: firebaseBootstrapError } = await loadFirebaseBootstrap();

if (firebaseBootstrapError) {
  document.getElementById("authStatus").textContent = "找不到 firebase-config.js，請先完成設定。";
}

const DEFAULT_CATEGORIES = [
  { name: "餐飲費", type: "expense", order: 0 },
  { name: "薪資收入", type: "income", order: 0 },
  { name: "利息", type: "nonOperatingIncome", order: 100 },
  { name: "保規費", type: "nonOperatingExpense", order: 100 }
];

const PROTECTED_ITEMS = [
  { collection: "accounts", type: "asset", name: "現金", order: 0 },
  { collection: "accounts", type: "liability", name: "應付帳款", order: 0 },
  { collection: "categories", type: "income", name: "薪資收入", aliases: ["薪資"], order: 0 },
  { collection: "categories", type: "expense", name: "餐飲費", aliases: ["餐飲"], order: 0 }
];

function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

const state = {
  uid: null,
  accounts: [],
  categories: [],
  transactions: [],
  monthlySnapshots: [],
  loadedSnapshotMonths: new Set(),
  loadedLatestSnapshotBeforeTargets: new Set(),
  hasTransactions: false,
  earliestTransactionMonth: "",
  earliestSnapshotMonth: "",
  recurring: [],
  transactionRange: "week",
  transactionEditMode: false,
  mobileSelectedTransactionId: "",
  mobileEditingTransactionId: "",
  desktopSelectedTransactionId: "",
  desktopEditingTransactionId: "",
  transactionSourceType: localStorage.getItem("financeTransactionSourceType") || "asset",
  transactionDestinationType: localStorage.getItem("financeTransactionDestinationType") || "asset",
  desktopMode: localStorage.getItem("financeDesktopMode") === "true",
  desktopLoading: false,
  desktopLoadRequestId: 0,
  desktopSidebarStructureRenderKey: "",
  transactionTableHeaderRenderKey: "",
  transactionTableBodyRenderKey: "",
  derivedDataRevision: 0,
  derivedDataCache: {
    accountBalances: new Map(),
    desktopBalanceMaps: new Map(),
    filteredTransactions: new Map(),
    chartData: new Map(),
    selectedTransactions: new Map(),
    transactionOptionItems: new Map()
  },
  desktopCollapsedGroups: readJsonStorage("financeDesktopCollapsedGroups", {}),
  desktopDate: localStorage.getItem("financeDesktopDate") || currentMonthKey(),
  desktopSidebarSelection: null,
  desktopSidebarUiState: {
    netWorthSelected: false,
    selectedGroupKey: "",
    selectedItemKey: "",
    collapsedGroups: {}
  },
  desktopTransactionActionsRenderKey: "",
  mobileTransactionActionsRenderKey: "",
  readonlyTransactionSelectionUiState: {
    mobileSelectedId: "",
    desktopSelectedId: ""
  },
  desktopSettingsTabsRendered: false,
  desktopSettingsListRenderKey: "",
  desktopSettingsUiState: {
    activeType: "",
    selectedItemKey: ""
  },
  desktopSettingsType: "asset",
  desktopSettingsSelectedId: "",
  desktopItemEditing: null,
  commonSummaryEditingScopeKey: "",
  commonSummaries: loadCommonSummaryStore(),
  settings: {
    monthlyBudget: 0,
    recurringAppliedMonth: "",
    snapshotDirtyFromMonth: "",
    legacyTransactionsCheckedAt: 0
  },
  pieChart: null,
  barChart: null
};

const $ = (id) => document.getElementById(id);
const fmt = (value) =>
  new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0
  }).format(Number(value || 0));

function showMessage(message, title = "訊息") {
  const modal = $("messageModal");
  const titleNode = $("messageModalTitle");
  const bodyNode = $("messageModalBody");
  if (!modal || !titleNode || !bodyNode) {
    window.alert(message);
    return;
  }
  titleNode.textContent = title;
  bodyNode.textContent = String(message || "");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeMessageModal() {
  const modal = $("messageModal");
  if (!modal) {
    return;
  }
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function invalidateDerivedDataCache() {
  state.derivedDataRevision += 1;
  state.derivedDataCache.accountBalances.clear();
  state.derivedDataCache.desktopBalanceMaps.clear();
  state.derivedDataCache.filteredTransactions.clear();
  state.derivedDataCache.chartData.clear();
  state.derivedDataCache.selectedTransactions.clear();
  state.derivedDataCache.transactionOptionItems.clear();
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function currentMonthKey(date = new Date()) {
  return todayKey(date).slice(0, 7);
}

function monthKey(date) {
  return String(date || "").slice(0, 7);
}

function earlierMonth(firstMonth, secondMonth) {
  const months = [String(firstMonth || "").trim(), String(secondMonth || "").trim()].filter((value) => /^\d{4}-\d{2}$/.test(value));
  if (!months.length) {
    return "";
  }
  return months.sort()[0];
}

function previousMonth(month) {
  const value = String(month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(value)) {
    return "";
  }
  const [year, monthValue] = value.split("-").map(Number);
  const date = new Date(year, monthValue - 1, 1);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function isSnapshotUsable(month) {
  const value = String(month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(value)) {
    return false;
  }
  const dirtyFromMonth = String(state.settings.snapshotDirtyFromMonth || "").trim();
  return !dirtyFromMonth || value < dirtyFromMonth;
}

function getMonthlySnapshot(month) {
  if (!isSnapshotUsable(month)) {
    return null;
  }
  return state.monthlySnapshots.find((snapshot) => snapshot.month === month) || null;
}

function getLatestUsableSnapshotBefore(month) {
  const target = String(month || "").trim();
  const candidates = state.monthlySnapshots
    .filter((snapshot) => isSnapshotUsable(snapshot.month) && snapshot.month < target)
    .sort((a, b) => String(b.month || "").localeCompare(String(a.month || "")));
  return candidates[0] || null;
}

let db;
let auth;

if (firebaseConfig) {
  ({ db, auth } = initializeFirebaseServices(firebaseConfig, firebaseRuntime) || {});
  bindEvents();

  onAuthStateChanged(auth, async (user) => {
    authInitialized = true;
    if (!user) {
      state.uid = null;
      resetStateData();
      renderAuthState(null);
      renderAll();
      return;
    }

    state.uid = user.uid;
    renderAuthState(user);
    await bootstrap();
  });
}

window.setTimeout(() => {
  if (!authInitialized && document.getElementById("authStatus")?.textContent === "等待 Firebase 連線") {
    document.getElementById("authStatus").textContent = "Firebase 初始化逾時";
    document.getElementById("authError").textContent = "前端沒有成功完成 Firebase 初始化，請重新整理頁面；若仍發生，請回報這一行訊息。";
  }
}, 5000);

function resetStateData() {
  state.accounts = [];
  state.categories = [];
  state.transactions = [];
  state.monthlySnapshots = [];
  state.loadedSnapshotMonths.clear();
  state.loadedLatestSnapshotBeforeTargets.clear();
  state.hasTransactions = false;
  state.earliestTransactionMonth = "";
  state.earliestSnapshotMonth = "";
  state.recurring = [];
  state.transactionEditMode = false;
  state.settings = {
    monthlyBudget: 0,
    recurringAppliedMonth: "",
    snapshotDirtyFromMonth: "",
    legacyTransactionsCheckedAt: 0
  };
  invalidateDerivedDataCache();
}

async function markSnapshotDirtyFromMonth(month) {
  const normalizedMonth = String(month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth) || !state.uid) {
    return;
  }
  const nextMonth = earlierMonth(state.settings.snapshotDirtyFromMonth, normalizedMonth) || normalizedMonth;
  if (nextMonth === state.settings.snapshotDirtyFromMonth) {
    return;
  }
  state.settings.snapshotDirtyFromMonth = nextMonth;
  await saveSettingsPatch(db, state.uid, {
    snapshotDirtyFromMonth: nextMonth
  });
}

function getEarliestTransactionMonth() {
  return state.transactions
    .map((transaction) => monthKey(transaction.date))
    .filter((value) => /^\d{4}-\d{2}$/.test(value))
    .sort()[0] || "";
}

function getEarliestAccountTransactionMonth(accountId) {
  return state.transactions
    .filter(
      (transaction) =>
        (transaction.fromItem?.kind === "account" && transaction.fromItem?.id === accountId) ||
        (transaction.toItem?.kind === "account" && transaction.toItem?.id === accountId)
    )
    .map((transaction) => monthKey(transaction.date))
    .filter((value) => /^\d{4}-\d{2}$/.test(value))
    .sort()[0] || "";
}

function path(name) {
  return userCollectionRef(db, state.uid, name);
}

async function bootstrap() {
  await ensureDefaults();
  await deleteLegacyTransactions();
  await loadAll();
  if (await normalizeAllItemOrders()) {
    await loadAll();
  }
  bindEvents();
  await applyRecurringIfNeeded();
  renderAll();
}

async function ensureDefaults() {
  const settingsRef = userMetaRef(db, state.uid, "settings");
  const [settingsSnap, initialCategoriesSnap, accountsSnap] = await Promise.all([
    getDoc(settingsRef),
    getDocs(path("categories")),
    getDocs(path("accounts"))
  ]);
  if (!settingsSnap.exists()) {
    state.settings = {
      monthlyBudget: 0,
      recurringAppliedMonth: "",
      snapshotDirtyFromMonth: "",
      legacyTransactionsCheckedAt: 0
    };
    await replaceSettingsState(db, state.uid, state.settings);
  } else {
    state.settings = {
      monthlyBudget: Number(settingsSnap.data()?.monthlyBudget || 0),
      recurringAppliedMonth: String(settingsSnap.data()?.recurringAppliedMonth || ""),
      snapshotDirtyFromMonth: String(settingsSnap.data()?.snapshotDirtyFromMonth || ""),
      legacyTransactionsCheckedAt: Number(settingsSnap.data()?.legacyTransactionsCheckedAt || 0)
    };
  }

  let categoriesSnap = initialCategoriesSnap;
  if (categoriesSnap.empty) {
    for (const category of DEFAULT_CATEGORIES) {
      await createUserCollectionDocument(db, state.uid, "categories", { ...category, createdAt: Date.now() });
    }
    categoriesSnap = await getDocs(path("categories"));
  } else {
    await ensureDefaultCategories(categoriesSnap);
    categoriesSnap = await getDocs(path("categories"));
  }

  await ensureProtectedItems(accountsSnap, categoriesSnap);
}

async function ensureDefaultCategories(categoriesSnap) {
  const existing = categoriesSnap.docs.map((item) => item.data());
  await Promise.all(
    DEFAULT_CATEGORIES.map(async (category) => {
      const protectedItem = PROTECTED_ITEMS.find(
        (item) => item.collection === "categories" && item.type === category.type && item.name === category.name
      );
      const validNames = [category.name, ...(protectedItem?.aliases || [])];
      const exists = existing.some((item) => item.type === category.type && validNames.includes(String(item.name || "")));
      if (exists) {
        return;
      }
      await createUserCollectionDocument(db, state.uid, "categories", { ...category, createdAt: Date.now() });
    })
  );
}

async function ensureProtectedItems(accountsSnap, categoriesSnap) {
  await Promise.all(
    PROTECTED_ITEMS.map(async (protectedItem) => {
      const snap = protectedItem.collection === "accounts" ? accountsSnap : categoriesSnap;
      const match = snap.docs.find((item) => {
        const data = item.data();
        const type = protectedItem.collection === "accounts" ? inferAccountType(data) : data.type;
        return (
          type === protectedItem.type &&
          [protectedItem.name, ...(protectedItem.aliases || [])].includes(String(data.name || ""))
        );
      });
      const payload = {
        name: protectedItem.name,
        type: protectedItem.type,
        order: protectedItem.order
      };

      if (match) {
        const data = match.data();
        const currentType = protectedItem.collection === "accounts" ? inferAccountType(data) : data.type;
        if (String(data.name || "") === payload.name && currentType === payload.type && getItemOrder(data) === payload.order) {
          return;
        }
        await updateUserCollectionDocument(db, state.uid, protectedItem.collection, match.id, payload);
        return;
      }

      const defaults = protectedItem.collection === "accounts" ? { balance: 0 } : {};
      await createUserCollectionDocument(db, state.uid, protectedItem.collection, {
        ...payload,
        ...defaults,
        createdAt: Date.now()
      });
    })
  );
}

async function loadAll() {
  state.monthlySnapshots = [];
  state.loadedSnapshotMonths.clear();
  state.loadedLatestSnapshotBeforeTargets.clear();
  const [{ accounts, categories, recurring }, settingsData, historyMetadata] = await Promise.all([
    loadReferenceData(db, state.uid),
    loadSettingsState(db, state.uid),
    loadHistoryMetadata(db, state.uid)
  ]);
  state.accounts = accounts;
  state.categories = categories;
  state.recurring = recurring;
  state.earliestTransactionMonth = historyMetadata.earliestTransactionMonth;
  state.earliestSnapshotMonth = historyMetadata.earliestSnapshotMonth;
  state.settings = {
    monthlyBudget: 0,
    recurringAppliedMonth: "",
    snapshotDirtyFromMonth: "",
    legacyTransactionsCheckedAt: 0,
    ...settingsData
  };
  state.hasTransactions = historyMetadata.hasTransactions;
  await refreshTransactionsForCurrentView();
  invalidateDerivedDataCache();
}

function upsertMonthlySnapshot(snapshot) {
  if (!snapshot?.month) {
    return;
  }
  const index = state.monthlySnapshots.findIndex((item) => item.month === snapshot.month);
  if (index >= 0) {
    state.monthlySnapshots[index] = snapshot;
    return;
  }
  state.monthlySnapshots.push(snapshot);
}

async function loadSnapshotMonth(month) {
  const normalizedMonth = String(month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth) || state.loadedSnapshotMonths.has(normalizedMonth)) {
    return;
  }
  state.loadedSnapshotMonths.add(normalizedMonth);
  const snapshot = await loadSnapshotByMonth(db, state.uid, normalizedMonth);
  if (snapshot) {
    upsertMonthlySnapshot(snapshot);
  }
}

async function loadLatestSnapshotBefore(targetMonth) {
  const normalizedMonth = String(targetMonth || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth) || state.loadedLatestSnapshotBeforeTargets.has(normalizedMonth)) {
    return;
  }
  state.loadedLatestSnapshotBeforeTargets.add(normalizedMonth);
  const snapshot = await loadLatestSnapshotBeforeMonth(db, state.uid, normalizedMonth);
  if (snapshot) {
    upsertMonthlySnapshot(snapshot);
  }
}

function getRequiredSnapshotMonths() {
  const months = new Set();
  const currentMonth = currentMonthKey();
  months.add(currentMonth);

  const chartMonth = new Date();
  for (let index = 0; index < 6; index += 1) {
    months.add(currentMonthKey(chartMonth));
    chartMonth.setMonth(chartMonth.getMonth() - 1);
  }

  if (state.desktopMode) {
    months.add(state.desktopDate);
  }

  return Array.from(months).filter((month) => isSnapshotUsable(month));
}

async function ensureSnapshotCoverage() {
  if (!state.uid) {
    return;
  }

  await Promise.all(getRequiredSnapshotMonths().map((month) => loadSnapshotMonth(month)));

  const latestBeforeTargets = new Set([currentMonthKey()]);
  if (state.desktopMode) {
    latestBeforeTargets.add(state.desktopDate);
  }
  await Promise.all(Array.from(latestBeforeTargets).map((targetMonth) => loadLatestSnapshotBefore(targetMonth)));
}

function getMobileRangeDateBounds() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const start = new Date(end);

  if (state.transactionRange === "week") {
    start.setDate(start.getDate() - 6);
  } else if (state.transactionRange === "month") {
    start.setMonth(start.getMonth() - 1);
    start.setDate(start.getDate() + 1);
  } else if (state.transactionRange === "quarter") {
    start.setMonth(start.getMonth() - 3);
    start.setDate(start.getDate() + 1);
  } else {
    start.setMonth(start.getMonth() - 6);
    start.setDate(start.getDate() + 1);
  }

  start.setHours(0, 0, 0, 0);
  return {
    startDate: todayKey(start),
    endDate: todayKey(end)
  };
}

function getTransactionQueryScope() {
  const dirtyFromMonth = String(state.settings.snapshotDirtyFromMonth || "").trim();
  if (state.desktopMode) {
    const endMonth = state.desktopDate;
    const hasBaseSnapshot = Boolean(getLatestUsableSnapshotBefore(endMonth));
    const sixMonthFloor = previousMonth(previousMonth(previousMonth(previousMonth(previousMonth(endMonth)))));
    if (!dirtyFromMonth && !hasBaseSnapshot) {
      return {
        startDate: `${sixMonthFloor}-01`,
        endDate: `${endMonth}-31`
      };
    }
    const desiredStartMonth = dirtyFromMonth && dirtyFromMonth <= endMonth ? dirtyFromMonth : endMonth;
    const startMonth = desiredStartMonth < sixMonthFloor ? sixMonthFloor : desiredStartMonth;
    return {
      startDate: `${startMonth}-01`,
      endDate: `${endMonth}-31`
    };
  }

  const { startDate, endDate } = getMobileRangeDateBounds();
  const endMonth = monthKey(endDate || currentMonthKey());
  const hasBaseSnapshot = Boolean(getLatestUsableSnapshotBefore(endMonth) || getMonthlySnapshot(endMonth));
  if (!dirtyFromMonth && !hasBaseSnapshot) {
    return {
      startDate,
      endDate
    };
  }

  const startMonth = monthKey(startDate);
  const scopedStartMonth = dirtyFromMonth && dirtyFromMonth <= endMonth ? earlierMonth(dirtyFromMonth, startMonth) : startMonth;
  return {
    startDate: scopedStartMonth ? `${scopedStartMonth}-01` : startDate,
    endDate
  };
}

async function loadTransactionsForRange(startDate = "", endDate = "") {
  return loadTransactionsByDateRange(db, state.uid, startDate, endDate);
}

async function refreshTransactionsForCurrentView() {
  if (!state.uid) {
    state.transactions = [];
    invalidateDerivedDataCache();
    return;
  }
  await ensureSnapshotCoverage();
  const scope = getTransactionQueryScope();
  state.transactions = await loadTransactionsForRange(scope.startDate, scope.endDate);
  invalidateDerivedDataCache();
}

async function deleteLegacyTransactions() {
  if (state.settings.legacyTransactionsCheckedAt) {
    return;
  }

  const snap = await getDocs(path("transactions"));
  const legacyDocs = snap.docs.filter((item) => {
    const data = item.data();
    return !data.fromItem || !data.toItem;
  });

  await Promise.all(legacyDocs.map((item) => deleteUserCollectionDocument(db, state.uid, "transactions", item.id)));
  const checkedAt = Date.now();
  await saveSettingsPatch(db, state.uid, {
    legacyTransactionsCheckedAt: checkedAt
  });
  state.settings.legacyTransactionsCheckedAt = checkedAt;
}

function bindEvents() {
  if (bindEvents.bound) {
    return;
  }
  bindEvents.bound = true;

  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  $("overviewSettingsBtn").addEventListener("click", () => switchTab("settings"));

  document.querySelectorAll("#transactionRangeFilter .filter-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      state.transactionRange = button.dataset.range;
      await refreshTransactionsForCurrentView();
      renderTransactionRangeFilter();
      renderOverview();
      renderTransactions();
      renderCharts();
    });
  });

  $("sourceTypeSelect").addEventListener("change", () => {
    state.transactionSourceType = $("sourceTypeSelect").value;
    localStorage.setItem("financeTransactionSourceType", state.transactionSourceType);
    renderSourceItemOptions();
    renderCommonSummaryOptions();
  });

  $("destinationTypeSelect").addEventListener("change", (event) => {
    state.transactionDestinationType = event.currentTarget.value;
    localStorage.setItem("financeTransactionDestinationType", state.transactionDestinationType);
    renderDestinationItemOptions(state.transactionDestinationType);
    renderCommonSummaryOptions();
  });
  $("desktopSourceTypeSelect").addEventListener("change", () => {
    state.transactionSourceType = $("desktopSourceTypeSelect").value;
    localStorage.setItem("financeTransactionSourceType", state.transactionSourceType);
    renderDesktopSourceItemOptions();
    renderCommonSummaryOptions();
  });
  $("desktopDestinationTypeSelect").addEventListener("change", (event) => {
    state.transactionDestinationType = event.currentTarget.value;
    localStorage.setItem("financeTransactionDestinationType", state.transactionDestinationType);
    renderDesktopDestinationItemOptions(state.transactionDestinationType);
    renderCommonSummaryOptions();
  });

  $("transactionForm").addEventListener("submit", handleTransactionSubmit);
  $("desktopTransactionForm").addEventListener("submit", handleTransactionSubmit);
  bindMobileDateInputs();
  $("cancelMobileEditBtn").addEventListener("click", cancelMobileTransactionEdit);
  $("mobileEditTransactionBtn").addEventListener("click", editSelectedMobileTransaction);
  $("mobileDeleteTransactionBtn").addEventListener("click", deleteSelectedMobileTransaction);
  $("mobileItemTypeSelect").addEventListener("change", renderMobileItemFields);
  $("mobileItemForm").addEventListener("submit", saveMobileItem);

  $("budgetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    await saveSettingsPatch(db, state.uid, {
      monthlyBudget: Number(formData.get("monthlyBudget") || 0)
    });
    await loadAll();
    renderAll();
  });

  $("emailAuthForm").addEventListener("submit", handleEmailAuth);
  $("desktopViewBtn").addEventListener("click", toggleDesktopMode);
  $("desktopNetWorthCard").addEventListener("click", () => {
    if (!state.desktopMode) {
      return;
    }
    selectDesktopNetWorth();
  });
  $("desktopAccountTree").addEventListener("click", (event) => {
    const toggleButton = event.target.closest("[data-desktop-group-toggle]");
    if (toggleButton) {
      const key = toggleButton.dataset.desktopGroupToggle || "";
      state.desktopCollapsedGroups[key] = !state.desktopCollapsedGroups[key];
      localStorage.setItem("financeDesktopCollapsedGroups", JSON.stringify(state.desktopCollapsedGroups));
      syncDesktopSidebarUi();
      return;
    }

    const groupButton = event.target.closest("[data-desktop-group-select]");
    if (groupButton) {
      const key = groupButton.dataset.desktopGroupSelect || "";
      toggleDesktopSidebarSelection({ kind: "group", key, type: key });
      return;
    }

    const itemButton = event.target.closest("[data-desktop-item-select]");
    if (!itemButton) {
      return;
    }
    const key = itemButton.dataset.desktopItemSelect || "";
    const item = getDesktopSidebarItemByKey(key);
    if (item) {
      toggleDesktopSidebarSelection(item);
    }
  });
  $("transactionTableBody").addEventListener("click", (event) => {
    if (state.transactionEditMode) {
      return;
    }

    const mobileRow = event.target.closest(".mobile-transaction-row");
    if (mobileRow && !state.desktopMode) {
      state.mobileSelectedTransactionId = mobileRow.dataset.transactionId || "";
      updateReadonlyTransactionSelectionUi();
      renderMobileTransactionActions();
      return;
    }

    const desktopRow = event.target.closest(".desktop-transaction-row");
    if (desktopRow && state.desktopMode) {
      state.desktopSelectedTransactionId = desktopRow.dataset.transactionId || "";
      updateReadonlyTransactionSelectionUi();
      renderDesktopTransactionActions();
    }
  });
  $("transactionTableBody").addEventListener("keydown", (event) => {
    if (state.transactionEditMode || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    const row = event.target.closest(".mobile-transaction-row, .desktop-transaction-row");
    if (!row) {
      return;
    }

    event.preventDefault();
    row.click();
  });
  $("transactionTableBody").addEventListener("change", (event) => {
    if (!state.desktopMode || !state.transactionEditMode) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    const row = target.closest(".desktop-editable-row");
    if (!row) {
      return;
    }

    if (target.name === "fromType" || target.name === "toType") {
      updateDesktopEditableItemOptions(row, target.name === "fromType" ? "from" : "to");
      updateDesktopEditableTypePreview(row);
      return;
    }

    if (target.name === "fromId" || target.name === "toId") {
      updateDesktopEditableTypePreview(row);
    }
  });
  $("desktopYearSelect").addEventListener("change", handleDesktopDateChange);
  $("desktopMonthSelect").addEventListener("change", handleDesktopDateChange);
  document.querySelectorAll(".desktop-date-actions button").forEach((button, index) => {
    button.addEventListener("click", () => handleDesktopDateAction(index));
  });
  $("desktopEditRecordBtn").addEventListener("click", editSelectedDesktopTransaction);
  $("desktopEditBtn").addEventListener("click", startDesktopListEdit);
  $("desktopSaveBtn").addEventListener("click", saveEditedTransactions);
  $("desktopCancelEditBtn").addEventListener("click", cancelDesktopListEdit);
  $("desktopAddBtn").addEventListener("click", () => {
    openDesktopTransactionModal();
  });
  $("desktopModalCloseBtn").addEventListener("click", closeDesktopTransactionModal);
  $("desktopModalCancelBtn").addEventListener("click", closeDesktopTransactionModal);
  $("desktopTransactionModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeDesktopTransactionModal();
    }
  });
  $("desktopSettingsBtn").addEventListener("click", () => {
    openDesktopSettingsModal();
  });
  $("desktopSettingsCloseBtn").addEventListener("click", closeDesktopSettingsModal);
  $("desktopSettingsDoneBtn").addEventListener("click", closeDesktopSettingsModal);
  $("desktopExportItemsBtn").addEventListener("click", handleItemsTransfer);
  $("itemsImportInput").addEventListener("change", importItemsCsv);
  $("desktopEditSummariesBtn").addEventListener("click", () => {
    const scopeKey = getDesktopSettingsSummaryScopeKey();
    if (!scopeKey) {
      return;
    }
    openCommonSummaryModal(scopeKey);
  });
  $("desktopSourceSelect").addEventListener("change", renderCommonSummaryOptions);
  $("desktopDestinationSelect").addEventListener("change", renderCommonSummaryOptions);
  $("sourceSelect").addEventListener("change", renderCommonSummaryOptions);
  $("destinationSelect").addEventListener("change", renderCommonSummaryOptions);
  $("desktopSaveSummaryBtn").addEventListener("click", () => saveSummaryFromInput("desktopSummaryInput", "desktop"));
  $("mobileSaveSummaryBtn").addEventListener("click", () => saveSummaryFromInput("mobileSummaryInput", "mobile"));
  bindSummaryInput("desktopSummaryInput", "desktopSummaryMenu", "desktop");
  bindSummaryInput("mobileSummaryInput", "mobileSummaryMenu", "mobile");
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".summary-field")) {
      hideSummaryMenus();
    }
  });
  $("commonSummaryCloseBtn").addEventListener("click", closeCommonSummaryModal);
  $("commonSummaryCancelBtn").addEventListener("click", closeCommonSummaryModal);
  $("commonSummaryForm").addEventListener("submit", saveCommonSummaryForm);
  $("commonSummaryModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeCommonSummaryModal();
    }
  });
  renderCommonSummaryOptions();
  $("desktopSettingsModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeDesktopSettingsModal();
    }
  });
  $("desktopSettingsTabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-settings-type]");
    if (!button) {
      return;
    }
    state.desktopSettingsType = button.dataset.settingsType;
    state.desktopSettingsSelectedId = "";
    renderDesktopSettings();
  });
  $("desktopSettingsList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-settings-item]");
    if (!button) {
      return;
    }
    state.desktopSettingsSelectedId = button.dataset.settingsItem;
    renderDesktopSettings();
  });
  $("desktopItemAddBtn").addEventListener("click", () => openDesktopItemModal());
  $("desktopItemEditBtn").addEventListener("click", () => {
    if (state.desktopSettingsSelectedId) {
      openDesktopItemModal(state.desktopSettingsSelectedId);
    }
  });
  $("desktopItemDeleteBtn").addEventListener("click", deleteDesktopSettingsItem);
  $("desktopItemMoveUpBtn").addEventListener("click", () => moveDesktopSettingsItem(-1));
  $("desktopItemMoveDownBtn").addEventListener("click", () => moveDesktopSettingsItem(1));
  $("desktopItemCloseBtn").addEventListener("click", closeDesktopItemModal);
  $("desktopItemCancelBtn").addEventListener("click", closeDesktopItemModal);
  $("desktopItemModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeDesktopItemModal();
    }
  });
  $("messageModalCloseBtn").addEventListener("click", closeMessageModal);
  $("messageModalDoneBtn").addEventListener("click", closeMessageModal);
  $("messageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeMessageModal();
    }
  });
  $("desktopItemForm").addEventListener("submit", saveDesktopSettingsItem);
  $("desktopDeleteBtn").addEventListener("click", deleteSelectedDesktopTransaction);
  $("signOutBtn").addEventListener("click", async () => {
    $("authError").textContent = "";
    await signOut(auth);
  });
}

async function handleEmailAuth(event) {
  event.preventDefault();
  $("authError").textContent = "";
  const form = event.currentTarget;

  const formData = new FormData(form);
  const action = event.submitter?.value || "login";
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");

  try {
    $("authStatus").textContent = action === "register" ? "建立帳號中..." : "登入中...";

    if (action === "register") {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }

    form.reset();
  } catch (error) {
    $("authStatus").textContent = "登入失敗";
    $("authError").textContent = formatAuthError(action, error);
  }
}

function formatAuthError(action, error) {
  const code = String(error?.code || "");
  const prefix = action === "register" ? "建立帳號失敗" : "Email 登入失敗";
  const messages = {
    "auth/email-already-in-use": "這個 Email 已經註冊，請直接登入。",
    "auth/invalid-credential": "Email 或密碼不正確。",
    INVALID_LOGIN_CREDENTIALS: "Email 或密碼不正確，或這個帳號尚未註冊。",
    "auth/invalid-email": "Email 格式不正確。",
    "auth/missing-password": "請輸入密碼。",
    "auth/weak-password": "密碼至少需要 6 個字元。",
    "auth/user-not-found": "找不到這個帳號，請先註冊。",
    "auth/wrong-password": "密碼不正確。",
    "auth/network-request-failed": "網路連線失敗，請稍後再試。",
    "auth/too-many-requests": "嘗試次數過多，請稍後再試。"
  };

  return `${prefix}：${messages[code] || code || error?.message || "未知錯誤"}`;
}

async function handleTransactionSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const editingTransactionId = !state.desktopMode ? state.mobileEditingTransactionId : state.desktopEditingTransactionId;
  const previousTransaction = editingTransactionId
    ? state.transactions.find((transaction) => transaction.id === editingTransactionId)
    : null;
  const fromItem = buildTransactionItem(String(formData.get("sourceId") || ""));
  const toItem = buildTransactionItem(String(formData.get("destinationId") || ""));
  if (!isValidTransactionRoute(fromItem, toItem)) {
    showMessage("這個記錄組合不成立，請重新選擇從項目與至項目。", "資料錯誤");
    return;
  }

  const payload = {
    date: String(formData.get("date") || ""),
    fromItem,
    toItem,
    amount: Number(formData.get("amount")),
    note: String(formData.get("note") || ""),
    memo: String(formData.get("memo") || "")
  };
  if (!isValidTransactionPayload(payload)) {
    showMessage("請確認日期與金額格式正確。", "資料錯誤");
    return;
  }

  if (!state.desktopMode && state.mobileEditingTransactionId) {
    await saveUserCollectionDocument(db, state.uid, "transactions", state.mobileEditingTransactionId, payload);
    state.mobileSelectedTransactionId = state.mobileEditingTransactionId;
    state.mobileEditingTransactionId = "";
  } else if (state.desktopMode && state.desktopEditingTransactionId) {
    await saveUserCollectionDocument(db, state.uid, "transactions", state.desktopEditingTransactionId, payload);
    state.desktopSelectedTransactionId = state.desktopEditingTransactionId;
  } else {
    const transactionRef = await createUserCollectionDocument(db, state.uid, "transactions", payload);
    if (state.desktopMode) {
      state.desktopSelectedTransactionId = transactionRef.id;
    } else {
      state.mobileSelectedTransactionId = transactionRef.id;
    }
  }

  await markSnapshotDirtyFromMonth(earlierMonth(monthKey(previousTransaction?.date), monthKey(payload.date)));

  event.target.reset();
  closeDesktopTransactionModal();
  setTodayDefault();
  await loadAll();
  renderAll();
  if (!state.desktopMode) {
    resetMobileTransactionForm();
    switchTab("transactions");
  }
}

function openDesktopTransactionModal() {
  state.desktopEditingTransactionId = "";
  $("desktopTransactionTitle").textContent = "新增記錄";
  $("desktopTransactionForm").querySelector('button[type="submit"]').textContent = "新增記錄";
  $("desktopTransactionForm").reset();
  renderDesktopSourceTypeOptions();
  renderDesktopSourceItemOptions();
  renderDesktopDestinationTypeOptions();
  renderDesktopDestinationItemOptions(state.transactionDestinationType);
  $("desktopTransactionModal").classList.remove("hidden");
  $("desktopTransactionModal").setAttribute("aria-hidden", "false");
  setTodayDefault();
  $("desktopTransactionForm").querySelector('input[name="amount"]')?.focus();
}

function closeDesktopTransactionModal() {
  $("desktopTransactionModal").classList.add("hidden");
  $("desktopTransactionModal").setAttribute("aria-hidden", "true");
  state.desktopEditingTransactionId = "";
}

function editSelectedMobileTransaction() {
  const transaction = getSelectedMobileTransaction();
  if (!transaction) {
    return;
  }

  state.mobileEditingTransactionId = transaction.id;
  fillMobileTransactionForm(transaction);
  showMobileEditPanel();
}

function cancelMobileTransactionEdit() {
  $("transactionForm").reset();
  setTodayDefault();
  resetMobileTransactionForm();
  switchTab("transactions");
}

async function deleteSelectedMobileTransaction() {
  const transaction = getSelectedMobileTransaction();
  if (!transaction || !window.confirm("確定要刪除此筆記錄嗎？")) {
    return;
  }

  await deleteUserCollectionDocument(db, state.uid, "transactions", transaction.id);
  await markSnapshotDirtyFromMonth(monthKey(transaction.date));
  state.mobileSelectedTransactionId = "";
  state.mobileEditingTransactionId = "";
  await loadAll();
  renderAll();
}

function getSelectedMobileTransaction() {
  if (state.desktopMode) {
    return null;
  }

  return getSelectedTransactionFromCache("mobile", state.mobileSelectedTransactionId);
}

function fillMobileTransactionForm(transaction) {
  const form = $("transactionForm");
  const fromItem = getTransactionFromItem(transaction);
  const toItem = getTransactionToItem(transaction);

  fillTransactionItemControls({
    fromItem,
    toItem,
    sourceTypeSelectId: "sourceTypeSelect",
    sourceSelectId: "sourceSelect",
    destinationTypeSelectId: "destinationTypeSelect",
    destinationSelectId: "destinationSelect",
    renderSourceTypeOptionsFn: renderSourceTypeOptions,
    renderSourceItemOptionsFn: renderSourceItemOptions,
    renderDestinationTypeOptionsFn: renderDestinationTypeOptions,
    renderDestinationItemOptionsFn: renderDestinationItemOptions
  });

  form.elements.date.value = transaction.date || "";
  syncMobileDateField();
  form.elements.amount.value = transaction.amount || "";
  form.elements.note.value = transaction.note || "";
  form.elements.memo.value = transaction.memo || "";
  document.querySelector("#ledger .card h3").textContent = "編輯記錄";
  form.querySelector('button[type="submit"]').textContent = "儲存修改";
  $("cancelMobileEditBtn").classList.remove("hidden");
  form.elements.amount.focus();
}

function resetMobileTransactionForm() {
  state.mobileEditingTransactionId = "";
  document.body.classList.remove("mobile-editing-transaction");
  document.querySelector("#ledger .card h3").textContent = "新增記錄";
  $("cancelMobileEditBtn").classList.add("hidden");
  $("transactionForm").querySelector('button[type="submit"]').textContent = "新增記錄";
}

function renderMobileItemFields() {
  const isAccount = isDesktopAccountType($("mobileItemTypeSelect").value);
  $("mobileItemBalanceField").classList.toggle("hidden", !isAccount);
}

function normalizeItemName(value) {
  return String(value || "").trim();
}

function parseFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNonNegativeInteger(value) {
  const parsed = parseFiniteNumber(value);
  return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : null;
}

function findConflictingItemByName(name, options = {}) {
  const normalizedName = normalizeItemName(name);
  if (!normalizedName) {
    return null;
  }
  const excludeCollection = options.excludeCollection || "";
  const excludeId = options.excludeId || "";
  const accountMatch = state.accounts.find((account) => {
    if (excludeCollection === "accounts" && account.id === excludeId) {
      return false;
    }
    return normalizeItemName(account.name) === normalizedName;
  });
  if (accountMatch) {
    return { collection: "accounts", id: accountMatch.id, type: inferAccountType(accountMatch), name: accountMatch.name };
  }
  const categoryMatch = state.categories.find((category) => {
    if (excludeCollection === "categories" && category.id === excludeId) {
      return false;
    }
    return normalizeItemName(category.name) === normalizedName;
  });
  if (categoryMatch) {
    return { collection: "categories", id: categoryMatch.id, type: categoryMatch.type, name: categoryMatch.name };
  }
  return null;
}

async function saveMobileItem(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const type = String(formData.get("type"));
  const name = normalizeItemName(formData.get("name"));
  const order = parseNonNegativeInteger(formData.get("order"));
  if (!name) {
    showMessage("請輸入項目名稱。", "資料錯誤");
    return;
  }
  if (order === null) {
    showMessage("請確認次序為 0 以上的數字。", "資料錯誤");
    return;
  }
  if (findConflictingItemByName(name)) {
    showMessage(`項目名稱「${name}」已存在，所有類別不能重複。`, "資料錯誤");
    return;
  }

  if (isDesktopAccountType(type)) {
    const balance = parseFiniteNumber(formData.get("balance") || 0);
    if (balance === null) {
      showMessage("請確認期初餘額為有效數字。", "資料錯誤");
      return;
    }
    const itemRef = await createUserCollectionDocument(db, state.uid, "accounts", {
      name,
      balance,
      type,
      order,
      createdAt: Date.now()
    });
    await loadAll();
    await normalizeItemOrders(type, itemRef.id);
  } else {
    const itemRef = await createUserCollectionDocument(db, state.uid, "categories", {
      name,
      type,
      order,
      createdAt: Date.now()
    });
    await loadAll();
    await normalizeItemOrders(type, itemRef.id);
  }

  event.target.reset();
  renderMobileItemFields();
  await loadAll();
  renderAll();
}

function showMobileEditPanel() {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.remove("active");
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === "ledger");
  });
  document.body.classList.add("mobile-editing-transaction");
}

function editSelectedDesktopTransaction() {
  const transaction = getSelectedDesktopTransaction();
  if (!transaction) {
    return;
  }

  openDesktopTransactionModal();
  state.desktopEditingTransactionId = transaction.id;
  $("desktopTransactionTitle").textContent = "編輯記錄";
  $("desktopTransactionForm").querySelector('button[type="submit"]').textContent = "儲存修改";
  fillDesktopTransactionForm(transaction);
}

function startDesktopListEdit() {
  state.transactionEditMode = true;
  state.desktopSelectedTransactionId = "";
  renderTransactions();
}

function cancelDesktopListEdit() {
  state.transactionEditMode = false;
  renderTransactions();
}

async function deleteSelectedDesktopTransaction() {
  const transaction = getSelectedDesktopTransaction();
  if (!transaction || !window.confirm("確定要刪除此筆記錄嗎？")) {
    return;
  }

  await deleteUserCollectionDocument(db, state.uid, "transactions", transaction.id);
  await markSnapshotDirtyFromMonth(monthKey(transaction.date));
  state.desktopSelectedTransactionId = "";
  await loadAll();
  renderAll();
}

function getSelectedDesktopTransaction() {
  return getSelectedTransactionFromCache("desktop", state.desktopSelectedTransactionId);
}

function getSelectedTransactionFromCache(mode, transactionId) {
  if (!transactionId) {
    return null;
  }

  const cacheKey = `${state.derivedDataRevision}:${mode}:${state.desktopMode ? getFilteredTransactionsCacheKey() : "all"}:${transactionId}`;
  if (state.derivedDataCache.selectedTransactions.has(cacheKey)) {
    return state.derivedDataCache.selectedTransactions.get(cacheKey);
  }

  const transactions = mode === "mobile" ? getFilteredTransactions() : state.desktopMode ? getFilteredTransactions() : state.transactions;
  const selectedTransaction = transactions.find((transaction) => transaction.id === transactionId) || null;
  state.derivedDataCache.selectedTransactions.set(cacheKey, selectedTransaction);
  return selectedTransaction;
}

function transactionItemValue(item) {
  return item?.kind && item?.id ? `${item.kind}:${item.id}` : "";
}

function fillDesktopTransactionForm(transaction) {
  const form = $("desktopTransactionForm");
  const fromItem = getTransactionFromItem(transaction);
  const toItem = getTransactionToItem(transaction);

  fillTransactionItemControls({
    fromItem,
    toItem,
    sourceTypeSelectId: "desktopSourceTypeSelect",
    sourceSelectId: "desktopSourceSelect",
    destinationTypeSelectId: "desktopDestinationTypeSelect",
    destinationSelectId: "desktopDestinationSelect",
    renderSourceTypeOptionsFn: renderDesktopSourceTypeOptions,
    renderSourceItemOptionsFn: renderDesktopSourceItemOptions,
    renderDestinationTypeOptionsFn: renderDesktopDestinationTypeOptions,
    renderDestinationItemOptionsFn: renderDesktopDestinationItemOptions
  });

  form.elements.date.value = transaction.date || "";
  form.elements.amount.value = transaction.amount || "";
  form.elements.note.value = transaction.note || "";
  form.elements.memo.value = transaction.memo || "";
  form.elements.amount.focus();
}

function fillTransactionItemControls({
  fromItem,
  toItem,
  sourceTypeSelectId,
  sourceSelectId,
  destinationTypeSelectId,
  destinationSelectId,
  renderSourceTypeOptionsFn,
  renderSourceItemOptionsFn,
  renderDestinationTypeOptionsFn,
  renderDestinationItemOptionsFn
}) {
  state.transactionSourceType = fromItem.type || "asset";
  state.transactionDestinationType = toItem.type || "asset";
  localStorage.setItem("financeTransactionSourceType", state.transactionSourceType);
  localStorage.setItem("financeTransactionDestinationType", state.transactionDestinationType);

  renderSourceTypeOptionsFn();
  $(sourceTypeSelectId).value = state.transactionSourceType;
  renderSourceItemOptionsFn();
  $(sourceSelectId).value = transactionItemValue(fromItem);

  renderDestinationTypeOptionsFn();
  $(destinationTypeSelectId).value = state.transactionDestinationType;
  renderDestinationItemOptionsFn(state.transactionDestinationType);
  $(destinationSelectId).value = transactionItemValue(toItem);
  renderCommonSummaryOptions();
}

function openDesktopSettingsModal() {
  state.desktopSettingsSelectedId = "";
  $("desktopSettingsModal").classList.remove("hidden");
  $("desktopSettingsModal").setAttribute("aria-hidden", "false");
  renderDesktopSettings();
}

function closeDesktopSettingsModal() {
  $("desktopSettingsModal").classList.add("hidden");
  $("desktopSettingsModal").setAttribute("aria-hidden", "true");
}

function openDesktopItemModal(itemId = "") {
  const item = itemId ? getDesktopSettingsItem(itemId) : null;
  const protectedItem = isProtectedSettingsItem(item);
  state.desktopItemEditing = item;
  $("desktopItemTitle").textContent = `${item ? "修改" : "新增"}項目 - ${desktopSettingsTypeLabel(state.desktopSettingsType)}`;
  $("desktopItemForm").elements.name.value = item?.name || "";
  $("desktopItemForm").elements.balance.value = item?.balance ?? 0;
  $("desktopItemForm").elements.order.value = item?.order ?? getNextItemOrder(state.desktopSettingsType);
  $("desktopItemForm").elements.name.disabled = protectedItem;
  $("desktopItemForm").elements.order.disabled = protectedItem;
  $("desktopItemBalanceField").classList.toggle("hidden", !isDesktopAccountType(state.desktopSettingsType));
  $("desktopItemModal").classList.remove("hidden");
  $("desktopItemModal").setAttribute("aria-hidden", "false");
  $("desktopItemForm").elements.name.focus();
}

function closeDesktopItemModal() {
  $("desktopItemModal").classList.add("hidden");
  $("desktopItemModal").setAttribute("aria-hidden", "true");
  state.desktopItemEditing = null;
  $("desktopItemForm").elements.name.disabled = false;
  $("desktopItemForm").elements.order.disabled = false;
}

function renderAuthState(user) {
  if (!user) {
    document.body.classList.add("auth-signed-out");
    $("appShell").classList.add("hidden");
    $("emailAuthForm").classList.remove("hidden");
    $("signedInControls").classList.add("hidden");
    if (!$("authError").textContent) {
      $("authStatus").textContent = "請輸入 Email 與密碼登入或註冊";
    }
    return;
  }

  document.body.classList.remove("auth-signed-out");
  $("authStatus").textContent = getDisplayName(user);
  $("appShell").classList.remove("hidden");
  $("emailAuthForm").classList.add("hidden");
  $("signedInControls").classList.remove("hidden");
}

function getDisplayName(user) {
  return user.email ? user.email.split("@")[0] : user.uid;
}

function setActiveTabUi(tabId) {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  document.body.classList.toggle("mobile-transactions-tab", !state.desktopMode && tabId === "transactions");
}

function renderDesktopLoadingState() {
  document.body.classList.toggle("desktop-loading", state.desktopMode && state.desktopLoading);

  const loadingOverlay = $("desktopLoadingOverlay");
  const loadingText = $("desktopLoadingText");
  if (loadingOverlay) {
    loadingOverlay.classList.toggle("hidden", !(state.desktopMode && state.desktopLoading));
    loadingOverlay.setAttribute("aria-hidden", state.desktopMode && state.desktopLoading ? "false" : "true");
  }
  if (loadingText) {
    loadingText.textContent = state.desktopMode ? "載入桌面版資料中..." : "";
  }

  const desktopViewBtn = $("desktopViewBtn");
  if (desktopViewBtn) {
    desktopViewBtn.disabled = state.desktopLoading;
    desktopViewBtn.textContent = state.desktopLoading ? "切換中..." : state.desktopMode ? "行動版" : "桌面版";
  }
}

function setDesktopLoading(isLoading) {
  state.desktopLoading = isLoading;
  renderDesktopLoadingState();
}

async function switchTab(tabId) {
  setActiveTabUi(tabId);

  if (!state.desktopMode && tabId !== "ledger" && state.mobileEditingTransactionId) {
    $("transactionForm").reset();
    setTodayDefault();
    resetMobileTransactionForm();
  }

  if (!state.desktopMode && !state.mobileEditingTransactionId) {
    document.body.classList.remove("mobile-editing-transaction");
  }

  if (tabId === "transactions" || tabId === "overview") {
    await refreshTransactionsForCurrentView();
    renderOverview();
    renderTransactions();
    renderCharts();
    renderDesktopSidebar();
  }
}

async function applyRecurringIfNeeded() {
  const currentMonth = currentMonthKey();
  if (state.settings.recurringAppliedMonth === currentMonth) {
    return;
  }

  for (const item of state.recurring) {
    const date = `${currentMonth}-${String(Math.min(item.day, 28)).padStart(2, "0")}`;
    await createUserCollectionDocument(db, state.uid, "transactions", {
      date,
      fromItem: accountItem(item.accountId),
      toItem: categoryItem(item.categoryId),
      amount: item.amount,
      note: `固定支出：${item.name}`,
    });
  }

  await saveSettingsPatch(db, state.uid, {
    recurringAppliedMonth: currentMonth,
    snapshotDirtyFromMonth: earlierMonth(state.settings.snapshotDirtyFromMonth, currentMonth) || currentMonth
  });
  state.settings.snapshotDirtyFromMonth = earlierMonth(state.settings.snapshotDirtyFromMonth, currentMonth) || currentMonth;
  await loadAll();
}

function renderAll() {
  renderDesktopMode();
  renderOptions();
  renderOverview();
  renderTransactionRangeFilter();
  renderTransactions();
  renderCharts();
  renderDesktopSidebar();
  renderDesktopSettings();
}

function getDesktopSidebarStructureRenderKey(groups) {
  return groups
    .map((group) => `${group.key}:${group.items.map((item) => item.key).join(",")}`)
    .join("|");
}

async function toggleDesktopMode() {
  state.desktopMode = !state.desktopMode;
  localStorage.setItem("financeDesktopMode", String(state.desktopMode));
  renderDesktopMode();
  renderDesktopLoadingState();

  if (!state.desktopMode) {
    await refreshTransactionsForCurrentView();
    renderOverview();
    renderTransactions();
    renderCharts();
    renderDesktopSidebar();
    return;
  }

  const requestId = state.desktopLoadRequestId + 1;
  state.desktopLoadRequestId = requestId;
  setDesktopLoading(true);

  try {
    await refreshTransactionsForCurrentView();
    if (!state.desktopMode || state.desktopLoadRequestId !== requestId) {
      return;
    }
    renderOverview();
    renderTransactions();
    renderCharts();
    renderDesktopSidebar();
  } finally {
    if (state.desktopMode && state.desktopLoadRequestId === requestId) {
      setDesktopLoading(false);
    }
  }
}

function renderDesktopMode() {
  document.body.classList.toggle("desktop-mode", state.desktopMode);
  document.body.classList.toggle("mobile-mode", !state.desktopMode);
  renderDesktopLoadingState();
  syncDesktopDateControls();
  setDesktopPanelState();
  if (state.desktopMode) {
    state.transactionEditMode = false;
    setActiveTabUi("transactions");
  }
}

function setDesktopPanelState() {
  document.querySelectorAll("main > .tab-panel").forEach((panel) => {
    panel.classList.toggle("desktop-panel", state.desktopMode && panel.id === "transactions");
  });
}

function renderDesktopSidebar() {
  if (!state.desktopMode) {
    return;
  }

  const balances = buildAccountBalances(state.desktopDate);
  const monthSnapshot = getMonthlySnapshot(state.desktopDate);
  const groups = buildDesktopSidebarGroups(balances, monthSnapshot);
  const assetTotal = getAccountBalanceTotal("asset", balances);
  const liabilityTotal = getAccountBalanceTotal("liability", balances);
  const structureRenderKey = getDesktopSidebarStructureRenderKey(groups);

  $("desktopNetWorth").textContent = fmt(assetTotal - liabilityTotal);
  const didRerenderStructure = state.desktopSidebarStructureRenderKey !== structureRenderKey;
  if (didRerenderStructure) {
    $("desktopAccountTree").innerHTML = groups
      .map((group) => {
        return `<section class="desktop-account-group">
          <div class="desktop-account-group-header" data-desktop-group-header="${group.key}">
            <button type="button" class="desktop-account-group-select" data-desktop-group-select="${group.key}">
              <div class="desktop-account-group-title">
                <span class="desktop-account-badge ${group.key}">${group.badge}</span>
                <div class="desktop-account-group-label">
                  <strong>${group.label}</strong>
                  <span data-desktop-group-total="${group.key}">${group.totalText}</span>
                </div>
              </div>
            </button>
            <button type="button" class="desktop-account-toggle" data-desktop-group-toggle="${group.key}" aria-label="${group.label}收合切換">
              ${state.desktopCollapsedGroups[group.key] ? "＋" : "－"}
            </button>
          </div>
          <div class="desktop-account-items" data-desktop-group-items="${group.key}">
            ${group.items
              .map((item) => {
                return `<button type="button" class="desktop-account-item" data-desktop-item-select="${escapeAttr(item.key)}">
                  <span class="desktop-account-icon">${escapeHtml(item.icon)}</span>
                  <div class="desktop-account-meta">
                    <strong data-desktop-item-name="${escapeAttr(item.key)}">${escapeHtml(item.name)}</strong>
                    <span data-desktop-item-value="${escapeAttr(item.key)}">${item.valueText}</span>
                  </div>
                </button>`;
              })
              .join("")}
          </div>
        </section>`;
      })
      .join("");
    state.desktopSidebarStructureRenderKey = structureRenderKey;
  }

  syncDesktopSidebarContent(groups);
  syncDesktopSidebarUi(didRerenderStructure);
}

function syncDesktopSidebarContent(groups) {
  groups.forEach((group) => {
    const totalNode = document.querySelector(`[data-desktop-group-total="${group.key}"]`);
    if (totalNode && totalNode.textContent !== group.totalText) {
      totalNode.textContent = group.totalText;
    }

    group.items.forEach((item) => {
      const selectorKey = CSS.escape(item.key);
      const nameNode = document.querySelector(`[data-desktop-item-name="${selectorKey}"]`);
      if (nameNode && nameNode.textContent !== item.name) {
        nameNode.textContent = item.name;
      }

      const valueNode = document.querySelector(`[data-desktop-item-value="${selectorKey}"]`);
      if (valueNode && valueNode.textContent !== item.valueText) {
        valueNode.textContent = item.valueText;
      }
    });
  });
}

function isDesktopSidebarGroupSelected(key) {
  return state.desktopSidebarSelection?.kind === "group" && state.desktopSidebarSelection.key === key;
}

function isDesktopSidebarItemSelected(key) {
  return state.desktopSidebarSelection?.kind === "item" && state.desktopSidebarSelection.key === key;
}

function isDesktopNetWorthSelected() {
  return state.desktopSidebarSelection?.kind === "netWorth";
}

function selectDesktopNetWorth() {
  state.desktopSidebarSelection = { kind: "netWorth", key: "netWorth" };
  state.desktopSelectedTransactionId = "";
  syncDesktopSidebarUi();
  renderTransactions();
}

function toggleDesktopSidebarSelection(selection) {
  const current = state.desktopSidebarSelection;
  const isSameSelection =
    current?.kind === selection.kind &&
    current?.key === selection.key;

  state.desktopSidebarSelection = isSameSelection ? null : selection;
  state.desktopSelectedTransactionId = "";
  syncDesktopSidebarUi();
  renderTransactions();
}

function syncDesktopSidebarUi(forceFullSync = false) {
  const nextUiState = {
    netWorthSelected: isDesktopNetWorthSelected(),
    selectedGroupKey: state.desktopSidebarSelection?.kind === "group" ? state.desktopSidebarSelection.key : "",
    selectedItemKey: state.desktopSidebarSelection?.kind === "item" ? state.desktopSidebarSelection.key : "",
    collapsedGroups: { ...state.desktopCollapsedGroups }
  };

  if (forceFullSync) {
    syncDesktopSidebarUiFull(nextUiState);
  } else {
    syncDesktopSidebarUiDiff(state.desktopSidebarUiState, nextUiState);
  }

  state.desktopSidebarUiState = nextUiState;
}

function syncDesktopSidebarUiFull(nextUiState) {
  $("desktopNetWorthCard").classList.toggle("selected", nextUiState.netWorthSelected);

  document.querySelectorAll("[data-desktop-group-header]").forEach((element) => {
    const key = element.dataset.desktopGroupHeader || "";
    element.classList.toggle("selected", key === nextUiState.selectedGroupKey);
  });

  document.querySelectorAll("[data-desktop-item-select]").forEach((element) => {
    const key = element.dataset.desktopItemSelect || "";
    element.classList.toggle("selected", key === nextUiState.selectedItemKey);
  });

  document.querySelectorAll("[data-desktop-group-toggle]").forEach((element) => {
    const key = element.dataset.desktopGroupToggle || "";
    syncDesktopSidebarGroupCollapsedUi(key, Boolean(nextUiState.collapsedGroups[key]));
  });
}

function syncDesktopSidebarUiDiff(previousUiState, nextUiState) {
  if (previousUiState.netWorthSelected !== nextUiState.netWorthSelected) {
    $("desktopNetWorthCard").classList.toggle("selected", nextUiState.netWorthSelected);
  }

  if (previousUiState.selectedGroupKey !== nextUiState.selectedGroupKey) {
    setDesktopSidebarGroupSelected(previousUiState.selectedGroupKey, false);
    setDesktopSidebarGroupSelected(nextUiState.selectedGroupKey, true);
  }

  if (previousUiState.selectedItemKey !== nextUiState.selectedItemKey) {
    setDesktopSidebarItemSelected(previousUiState.selectedItemKey, false);
    setDesktopSidebarItemSelected(nextUiState.selectedItemKey, true);
  }

  const collapsedGroupKeys = new Set([
    ...Object.keys(previousUiState.collapsedGroups || {}),
    ...Object.keys(nextUiState.collapsedGroups || {})
  ]);
  collapsedGroupKeys.forEach((key) => {
    const previousCollapsed = Boolean(previousUiState.collapsedGroups?.[key]);
    const nextCollapsed = Boolean(nextUiState.collapsedGroups?.[key]);
    if (previousCollapsed !== nextCollapsed) {
      syncDesktopSidebarGroupCollapsedUi(key, nextCollapsed);
    }
  });
}

function setDesktopSidebarGroupSelected(key, selected) {
  if (!key) {
    return;
  }
  const element = document.querySelector(`[data-desktop-group-header="${CSS.escape(key)}"]`);
  if (element) {
    element.classList.toggle("selected", selected);
  }
}

function setDesktopSidebarItemSelected(key, selected) {
  if (!key) {
    return;
  }
  const element = document.querySelector(`[data-desktop-item-select="${CSS.escape(key)}"]`);
  if (element) {
    element.classList.toggle("selected", selected);
  }
}

function syncDesktopSidebarGroupCollapsedUi(key, collapsed) {
  const toggleElement = document.querySelector(`[data-desktop-group-toggle="${CSS.escape(key)}"]`);
  if (toggleElement) {
    toggleElement.textContent = collapsed ? "＋" : "－";
  }

  const itemsElement = document.querySelector(`[data-desktop-group-items="${CSS.escape(key)}"]`);
  if (itemsElement) {
    itemsElement.classList.toggle("hidden", collapsed);
  }
}

function getDesktopSidebarItemByKey(key) {
  for (const type of ["asset", "liability", "income", "expense", "nonOperatingIncome", "nonOperatingExpense"]) {
    const item = getDesktopSidebarItems(type).find((entry) => entry.key === key);
    if (item) {
      return item;
    }
  }
  return null;
}

function getDesktopSidebarItems(type) {
  if (type === "asset" || type === "liability") {
    return state.accounts
      .filter((account) => inferAccountType(account) === type)
      .sort(sortItemsByOrder)
      .map((account) => ({
        kind: "item",
        key: `account:${account.id}`,
        id: account.id,
        itemKind: "account",
        itemType: type,
        name: account.name,
        icon: accountIcon(account, type)
      }));
  }

  return state.categories
    .filter((category) => category.type === type)
    .sort(sortItemsByOrder)
    .map((category) => ({
      kind: "item",
      key: `category:${category.id}`,
      id: category.id,
      itemKind: "category",
      itemType: type,
      name: category.name,
      icon: categoryIcon(category)
    }));
}

function renderDesktopSettings() {
  const tabs = [
    { type: "asset", label: "資產", icon: "A" },
    { type: "liability", label: "負債", icon: "L" },
    { type: "income", label: "收入", icon: "I" },
    { type: "expense", label: "支出", icon: "E" },
    { type: "nonOperatingIncome", label: "業外收入", icon: "N" },
    { type: "nonOperatingExpense", label: "業外支出", icon: "O" }
  ];

  if (!state.desktopSettingsTabsRendered) {
    $("desktopSettingsTabs").innerHTML = tabs
      .map(
        (tab) => `<button type="button" data-settings-type="${tab.type}">
          <span class="desktop-account-badge ${tab.type}">${tab.icon}</span>${tab.label}
        </button>`
      )
      .join("");
    state.desktopSettingsTabsRendered = true;
  }

  const items = getDesktopSettingsItems(state.desktopSettingsType);
  const listRenderKey = getDesktopSettingsListRenderKey(items);
  const didRerenderList = state.desktopSettingsListRenderKey !== listRenderKey;
  if (didRerenderList) {
    $("desktopSettingsList").innerHTML =
      items
        .map((item) => {
          const amount = isDesktopAccountType(state.desktopSettingsType) ? `: ${fmt(item.balance || 0)}` : "";
          return `<button type="button" class="desktop-settings-item" data-settings-item="${escapeAttr(item.key)}">
            <span class="desktop-settings-icon">${escapeHtml(item.icon)}</span>
            <span>${escapeHtml(item.name)}<strong>${amount}</strong><small>次序 ${getItemOrder(item)}</small></span>
            <em class="hidden" data-settings-check="${escapeAttr(item.key)}">✓</em>
          </button>`;
        })
        .join("") || '<p class="desktop-settings-empty">此類別目前無項目</p>';
    state.desktopSettingsListRenderKey = listRenderKey;
  }

  syncDesktopSettingsUi(didRerenderList);

  const hasSelection = Boolean(state.desktopSettingsSelectedId);
  const selectedItem = getDesktopSettingsItem(state.desktopSettingsSelectedId);
  const movableItems = getMovableDesktopSettingsItems();
  const selectedIndex = movableItems.findIndex((item) => item.key === state.desktopSettingsSelectedId);
  $("desktopExportItemsBtn").textContent = isItemImportMode() ? "匯入項目" : "匯出項目";
  $("desktopItemEditBtn").disabled = !hasSelection;
  $("desktopItemDeleteBtn").disabled = !hasSelection;
  $("desktopItemMoveUpBtn").disabled = !selectedItem || selectedItem.protected || selectedIndex <= 0;
  $("desktopItemMoveDownBtn").disabled =
    !selectedItem || selectedItem.protected || selectedIndex < 0 || selectedIndex >= movableItems.length - 1;
  $("desktopEditSummariesBtn").disabled = !selectedItem || isDesktopAccountType(selectedItem.type);
}

function getDesktopSettingsListRenderKey(items) {
  return `${state.desktopSettingsType}:${items
    .map((item) => `${item.key}:${item.name}:${item.order}:${Number(item.balance || 0)}:${item.protected ? "1" : "0"}`)
    .join("|")}`;
}

function syncDesktopSettingsUi(forceFullSync = false) {
  const nextUiState = {
    activeType: state.desktopSettingsType,
    selectedItemKey: state.desktopSettingsSelectedId
  };

  if (forceFullSync) {
    syncDesktopSettingsUiFull(nextUiState);
  } else {
    syncDesktopSettingsUiDiff(state.desktopSettingsUiState, nextUiState);
  }

  state.desktopSettingsUiState = nextUiState;
}

function syncDesktopSettingsUiFull(nextUiState) {
  document.querySelectorAll("[data-settings-type]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsType === nextUiState.activeType);
  });

  document.querySelectorAll("[data-settings-item]").forEach((button) => {
    const key = button.dataset.settingsItem || "";
    const selected = key === nextUiState.selectedItemKey;
    button.classList.toggle("selected", selected);
    const check = button.querySelector("[data-settings-check]");
    if (check) {
      check.classList.toggle("hidden", !selected);
    }
  });
}

function syncDesktopSettingsUiDiff(previousUiState, nextUiState) {
  if (previousUiState.activeType !== nextUiState.activeType) {
    setDesktopSettingsTypeActive(previousUiState.activeType, false);
    setDesktopSettingsTypeActive(nextUiState.activeType, true);
  }

  if (previousUiState.selectedItemKey !== nextUiState.selectedItemKey) {
    setDesktopSettingsItemSelected(previousUiState.selectedItemKey, false);
    setDesktopSettingsItemSelected(nextUiState.selectedItemKey, true);
  }
}

function setDesktopSettingsTypeActive(type, active) {
  if (!type) {
    return;
  }
  const button = document.querySelector(`[data-settings-type="${CSS.escape(type)}"]`);
  if (button) {
    button.classList.toggle("active", active);
  }
}

function setDesktopSettingsItemSelected(key, selected) {
  if (!key) {
    return;
  }
  const button = document.querySelector(`[data-settings-item="${CSS.escape(key)}"]`);
  if (!button) {
    return;
  }
  button.classList.toggle("selected", selected);
  const check = button.querySelector("[data-settings-check]");
  if (check) {
    check.classList.toggle("hidden", !selected);
  }
}

function getDesktopSettingsItems(type) {
  if (isDesktopAccountType(type)) {
    return state.accounts
      .filter((account) => inferAccountType(account) === type)
      .map((account) => ({
        key: `account:${account.id}`,
        id: account.id,
        collection: "accounts",
        name: account.name,
        balance: Number(account.balance || 0),
        order: getItemOrder(account),
        icon: accountIcon(account, type),
        type,
        protected: isProtectedDataItem("accounts", account)
      }))
      .sort(sortItemsByOrder);
  }

  return state.categories
    .filter((category) => category.type === type)
    .map((category) => ({
      key: `category:${category.id}`,
      id: category.id,
      collection: "categories",
      name: category.name,
      order: getItemOrder(category),
      icon: categoryIcon(category),
      type,
      protected: isProtectedDataItem("categories", category)
    }))
    .sort(sortItemsByOrder);
}

function getDesktopSettingsItem(key) {
  return getDesktopSettingsItems(state.desktopSettingsType).find((item) => item.key === key) || null;
}

function getMovableDesktopSettingsItems() {
  return getDesktopSettingsItems(state.desktopSettingsType).filter((item) => !item.protected);
}

function isDesktopAccountType(type) {
  return type === "asset" || type === "liability";
}

function isProtectedSettingsItem(item) {
  return Boolean(item?.protected);
}

function isProtectedDataItem(collection, item) {
  return PROTECTED_ITEMS.some((protectedItem) => {
    return (
      protectedItem.collection === collection &&
      protectedItem.type === item.type &&
      protectedItem.name === item.name
    );
  });
}

function getItemOrder(item) {
  return Number.isFinite(Number(item?.order)) ? Number(item.order) : 100;
}

function sortItemsByOrder(a, b) {
  const protectedCompare = Number(isProtectedAnyItem(b)) - Number(isProtectedAnyItem(a));
  if (protectedCompare !== 0) {
    return protectedCompare;
  }
  const orderCompare = getItemOrder(a) - getItemOrder(b);
  if (orderCompare !== 0) {
    return orderCompare;
  }
  return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
}

function isProtectedAnyItem(item) {
  return PROTECTED_ITEMS.some((protectedItem) => {
    return protectedItem.type === item?.type && protectedItem.name === item?.name;
  });
}

function getNextItemOrder(type) {
  const items = isDesktopAccountType(type)
    ? state.accounts.filter((item) => inferAccountType(item) === type)
    : state.categories.filter((item) => item.type === type);
  const maxOrder = items.reduce((max, item) => Math.max(max, getItemOrder(item)), 0);
  return Math.max(100, maxOrder + 10);
}

async function normalizeAllItemOrders() {
  let changed = false;
  for (const type of ["asset", "liability", "income", "expense", "nonOperatingIncome", "nonOperatingExpense"]) {
    changed = (await normalizeItemOrders(type)) || changed;
  }
  return changed;
}

async function normalizeItemOrders(type, selectedId = "") {
  const items = getOrderNormalizationItems(type);
  if (!hasDuplicateItemOrders(items)) {
    return false;
  }

  const normalizedItems = items.sort(sortItemsByOrder);
  const updates = [];
  let nextOrder = 10;

  normalizedItems.forEach((item) => {
    const nextValue = item.protected ? 0 : nextOrder;
    if (!item.protected) {
      nextOrder += 10;
    }
    if (getItemOrder(item) !== nextValue) {
      updates.push({
        collection: item.collection,
        id: item.id,
        order: nextValue
      });
    }
  });

  if (!updates.length) {
    return false;
  }
  await batchUpdateUserCollectionOrders(db, state.uid, updates);
  if (selectedId) {
    state.desktopSettingsSelectedId = `${isDesktopAccountType(type) ? "account" : "category"}:${selectedId}`;
  }
  return true;
}

function getOrderNormalizationItems(type) {
  if (isDesktopAccountType(type)) {
    return state.accounts
      .filter((account) => inferAccountType(account) === type)
      .map((account) => ({
        id: account.id,
        collection: "accounts",
        name: account.name,
        type,
        order: getItemOrder(account),
        protected: isProtectedDataItem("accounts", { ...account, type })
      }));
  }

  return state.categories
    .filter((category) => category.type === type)
    .map((category) => ({
      id: category.id,
      collection: "categories",
      name: category.name,
      type,
      order: getItemOrder(category),
      protected: isProtectedDataItem("categories", category)
    }));
}

function hasDuplicateItemOrders(items) {
  const seen = new Set();
  return items.some((item) => {
    const order = getItemOrder(item);
    if (seen.has(order)) {
      return true;
    }
    seen.add(order);
    return false;
  });
}

function desktopSettingsTypeLabel(type) {
  const labels = {
    asset: "資產",
    liability: "負債",
    income: "收入",
    expense: "支出",
    nonOperatingIncome: "業外收入",
    nonOperatingExpense: "業外支出"
  };
  return labels[type] || "項目";
}

async function saveDesktopSettingsItem(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const type = state.desktopSettingsType;
  const editing = state.desktopItemEditing;
  const name = editing?.protected ? editing.name : normalizeItemName(formData.get("name"));
  const order = editing?.protected ? editing.order : parseNonNegativeInteger(formData.get("order"));
  if (!name) {
    showMessage("請輸入項目名稱。", "資料錯誤");
    return;
  }
  if (!editing?.protected && order === null) {
    showMessage("請確認次序為 0 以上的數字。", "資料錯誤");
    return;
  }
  const conflict = findConflictingItemByName(name, {
    excludeCollection: editing?.collection || (isDesktopAccountType(type) ? "accounts" : "categories"),
    excludeId: editing?.id || ""
  });
  if (conflict) {
    showMessage(`項目名稱「${name}」已存在，所有類別不能重複。`, "資料錯誤");
    return;
  }

  if (isDesktopAccountType(type)) {
    const balance = parseFiniteNumber(formData.get("balance") || 0);
    if (balance === null) {
      showMessage("請確認期初餘額為有效數字。", "資料錯誤");
      return;
    }
    const payload = {
      name,
      balance,
      type,
      order
    };
    if (editing) {
      const previousBalance = Number(editing.balance || 0);
      await updateUserCollectionDocument(db, state.uid, "accounts", editing.id, payload);
      if (previousBalance !== payload.balance) {
        await markSnapshotDirtyFromMonth(getEarliestAccountTransactionMonth(editing.id) || getEarliestTransactionMonth());
      }
      await loadAll();
      await normalizeItemOrders(type, editing.id);
    } else {
      const itemRef = await createUserCollectionDocument(db, state.uid, "accounts", { ...payload, createdAt: Date.now() });
      await loadAll();
      await normalizeItemOrders(type, itemRef.id);
    }
  } else {
    const payload = {
      name,
      type,
      order
    };
    if (editing) {
      await updateUserCollectionDocument(db, state.uid, "categories", editing.id, payload);
      await loadAll();
      await normalizeItemOrders(type, editing.id);
    } else {
      const itemRef = await createUserCollectionDocument(db, state.uid, "categories", { ...payload, createdAt: Date.now() });
      await loadAll();
      await normalizeItemOrders(type, itemRef.id);
    }
  }

  closeDesktopItemModal();
  await loadAll();
  renderAll();
}

async function deleteDesktopSettingsItem() {
  const item = getDesktopSettingsItem(state.desktopSettingsSelectedId);
  if (!item) {
    return;
  }
  if (item.protected) {
    showMessage("此為系統項目，不能刪除。", "無法刪除");
    return;
  }
  if (!window.confirm("確定要刪除此項目嗎？")) {
    return;
  }
  if (isItemReferenced(item)) {
    showMessage("此項目已有記錄或固定支出在使用，不能直接刪除。", "無法刪除");
    return;
  }

  await deleteUserCollectionDocument(db, state.uid, item.collection, item.id);
  state.desktopSettingsSelectedId = "";
  await loadAll();
  renderAll();
}

async function moveDesktopSettingsItem(direction) {
  if (await normalizeItemOrders(state.desktopSettingsType)) {
    await loadAll();
  }

  const items = getMovableDesktopSettingsItems();
  const currentIndex = items.findIndex((item) => item.key === state.desktopSettingsSelectedId);
  const targetIndex = currentIndex + direction;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= items.length) {
    return;
  }

  const current = items[currentIndex];
  const reorderedItems = [...items];
  reorderedItems.splice(currentIndex, 1);
  reorderedItems.splice(targetIndex, 0, current);

  await batchUpdateUserCollectionOrders(
    db,
    state.uid,
    reorderedItems.map((item, index) => ({
      collection: item.collection,
      id: item.id,
      order: (index + 1) * 10
    }))
  );

  state.desktopSettingsSelectedId = current.key;
  await loadAll();
  renderAll();
}

function syncDesktopDateControls() {
  populateDesktopYearOptions();
  const [year, month] = state.desktopDate.split("-");
  $("desktopYearSelect").value = year;
  $("desktopMonthSelect").value = month;
}

function getDesktopYearRange() {
  const currentYear = new Date().getFullYear();
  const selectedYear = Number(String(state.desktopDate || "").slice(0, 4));
  const years = [
    selectedYear,
    Number(String(state.earliestTransactionMonth || "").slice(0, 4)),
    Number(String(state.earliestSnapshotMonth || "").slice(0, 4)),
    ...state.transactions
      .map((transaction) => Number(String(transaction.date || "").slice(0, 4)))
      .filter((year) => Number.isInteger(year) && year > 0),
    ...state.monthlySnapshots
      .map((snapshot) => Number(String(snapshot.month || "").slice(0, 4)))
      .filter((year) => Number.isInteger(year) && year > 0)
  ];
  years.push(currentYear);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  return { minYear, maxYear };
}

function getDesktopLoadedMonthTransactions() {
  return state.transactions.filter((transaction) => monthKey(transaction.date) === state.desktopDate);
}

function getCurrentMonthTransactionsFallback() {
  const currentMonth = currentMonthKey();
  return state.transactions.filter((transaction) => monthKey(transaction.date) === currentMonth);
}

function populateDesktopYearOptions() {
  const select = $("desktopYearSelect");
  const { minYear, maxYear } = getDesktopYearRange();
  const currentValue = String(select.value || "").trim();
  const options = [];
  for (let year = maxYear; year >= minYear; year -= 1) {
    options.push(`<option value="${year}">${year}</option>`);
  }
  select.innerHTML = options.join("");
  if (currentValue && Array.from(select.options).some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

async function handleDesktopDateChange() {
  state.desktopDate = `${$("desktopYearSelect").value}-${$("desktopMonthSelect").value}`;
  localStorage.setItem("financeDesktopDate", state.desktopDate);
  await refreshTransactionsForCurrentView();
  renderOverview();
  renderCharts();
  renderDesktopSidebar();
  renderTransactions();
}

async function handleDesktopDateAction(actionIndex) {
  const [year, month] = state.desktopDate.split("-").map(Number);
  const date = new Date(year, month - 1, 1);

  if (actionIndex === 0) {
    date.setMonth(date.getMonth() - 1);
  } else if (actionIndex === 1) {
    date.setMonth(date.getMonth() + 1);
  } else {
    const now = new Date();
    date.setFullYear(now.getFullYear(), now.getMonth(), 1);
  }

  state.desktopDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  localStorage.setItem("financeDesktopDate", state.desktopDate);
  syncDesktopDateControls();
  await refreshTransactionsForCurrentView();
  renderOverview();
  renderCharts();
  renderDesktopSidebar();
  renderTransactions();
}

function buildDesktopSidebarGroups(balances, monthSnapshot = null) {
  const monthTransactions = getDesktopLoadedMonthTransactions();

  const assetItems = buildDesktopAccountItems("asset", balances);
  const liabilityItems = buildDesktopAccountItems("liability", balances);

  const incomeItems = buildDesktopCategoryItems("income", monthTransactions, monthSnapshot);
  const expenseItems = buildDesktopCategoryItems("expense", monthTransactions, monthSnapshot);
  const nonOperatingIncomeItems = buildDesktopCategoryItems("nonOperatingIncome", monthTransactions, monthSnapshot);
  const nonOperatingExpenseItems = buildDesktopCategoryItems("nonOperatingExpense", monthTransactions, monthSnapshot);

  return [
    {
      key: "asset",
      label: "資產",
      badge: "A",
      items: assetItems,
      totalText: fmt(getAccountBalanceTotal("asset", balances))
    },
    {
      key: "liability",
      label: "負債",
      badge: "L",
      items: liabilityItems,
      totalText: fmt(getAccountBalanceTotal("liability", balances))
    },
    {
      key: "income",
      label: "收入",
      badge: "I",
      items: incomeItems,
      totalText: fmt(monthSnapshot ? getSnapshotMonthIncome(state.desktopDate) : incomeItems.reduce((sum, item) => sum + parseCurrency(item.valueText), 0))
    },
    {
      key: "expense",
      label: "支出",
      badge: "E",
      items: expenseItems,
      totalText: fmt(monthSnapshot ? getSnapshotMonthExpense(state.desktopDate) : expenseItems.reduce((sum, item) => sum + parseCurrency(item.valueText), 0))
    },
    {
      key: "nonOperatingIncome",
      label: "業外收入",
      badge: "N",
      items: nonOperatingIncomeItems,
      totalText: fmt(
        monthSnapshot
          ? nonOperatingIncomeItems.reduce((sum, item) => sum + parseCurrency(item.valueText), 0)
          : nonOperatingIncomeItems.reduce((sum, item) => sum + parseCurrency(item.valueText), 0)
      )
    },
    {
      key: "nonOperatingExpense",
      label: "業外支出",
      badge: "O",
      items: nonOperatingExpenseItems,
      totalText: fmt(
        monthSnapshot
          ? nonOperatingExpenseItems.reduce((sum, item) => sum + parseCurrency(item.valueText), 0)
          : nonOperatingExpenseItems.reduce((sum, item) => sum + parseCurrency(item.valueText), 0)
      )
    }
  ];
}

function buildDesktopAccountItems(type, balances) {
  return state.accounts
    .filter((account) => inferAccountType(account) === type)
    .sort(sortItemsByOrder)
    .map((account) => ({
      key: `account:${account.id}`,
      name: account.name,
      icon: accountIcon(account, type),
      valueText: fmt(balances[account.id] ?? account.balance ?? 0)
    }));
}

function buildDesktopCategoryItems(type, monthTransactions, monthSnapshot = null) {
  return state.categories
    .filter((category) => category.type === type)
    .sort(sortItemsByOrder)
    .map((category) => {
      if (monthSnapshot) {
        return {
          key: `category:${category.id}`,
          name: category.name,
          icon: categoryIcon(category),
          valueText: fmt(getSnapshotCategoryTotal(state.desktopDate, category.id))
        };
      }
      const amount = monthTransactions
        .filter((transaction) => {
          const transactionType = getTransactionType(transaction);
          const item =
            isIncomeCategoryType(type) || transactionType === "refund"
              ? getTransactionFromItem(transaction)
              : getTransactionToItem(transaction);
          if (item.id !== category.id) {
            return false;
          }
          if (transactionType === getCategoryFlowType(type)) {
            return true;
          }
          return isExpenseCategoryType(type) && transactionType === "refund";
        })
        .reduce((sum, transaction) => {
          const value = Number(transaction.amount || 0);
          return sum + (getTransactionType(transaction) === "refund" ? -value : value);
        }, 0);

      return {
        key: `category:${category.id}`,
        name: category.name,
        icon: categoryIcon(category),
        valueText: fmt(amount)
      };
    });
}

function getAccountBalanceTotal(type, balances) {
  return state.accounts
    .filter((account) => inferAccountType(account) === type)
    .reduce((sum, account) => sum + Number(balances[account.id] ?? account.balance ?? 0), 0);
}

function parseCurrency(valueText) {
  return Number(String(valueText).replace(/[^\d.-]/g, "")) || 0;
}

function inferAccountType(account) {
  if (account.type === "asset" || account.type === "liability") {
    return account.type;
  }
  const name = String(account.name || "");
  if (/信用卡|貸款|卡費|負債/.test(name)) {
    return "liability";
  }
  return "asset";
}

function accountIcon(account, group) {
  if (group === "liability") {
    return "💳";
  }
  if (/現金/.test(account.name || "")) {
    return "💵";
  }
  if (/銀行|帳戶/.test(account.name || "")) {
    return "🏦";
  }
  if (/股票|證券/.test(account.name || "")) {
    return "📈";
  }
  if (/基金/.test(account.name || "")) {
    return "🐷";
  }
  if (/投資/.test(account.name || "")) {
    return "📈";
  }
  return "📒";
}

function categoryIcon(category) {
  const name = String(category.name || "");
  if (isIncomeCategoryType(category.type)) {
    return /薪資|薪水/.test(name) ? "💰" : "✨";
  }
  if (/餐|飲食|便當/.test(name)) {
    return "🍱";
  }
  if (/交通|車|停車|加油/.test(name)) {
    return "🚗";
  }
  if (/生活|家用|日常/.test(name)) {
    return "🏠";
  }
  return "🧾";
}

function renderTransactionRangeFilter() {
  document.querySelectorAll("#transactionRangeFilter .filter-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === state.transactionRange);
  });
}

function renderOptions() {
  const accountOptions = state.accounts
    .map((account) => `<option value="${escapeAttr(account.id)}">${escapeHtml(account.name)}</option>`)
    .join("");
  renderSourceTypeOptions();
  renderSourceItemOptions();
  renderDestinationTypeOptions();
  renderDestinationItemOptions();
  renderDesktopSourceTypeOptions();
  renderDesktopSourceItemOptions();
  renderDesktopDestinationTypeOptions();
  renderDesktopDestinationItemOptions();
  renderMobileItemFields();
  renderCommonSummaryOptions();

  $("budgetForm").elements.monthlyBudget.value = Number(state.settings.monthlyBudget || 0);
  setTodayDefault();
}

function renderCommonSummaryOptions() {
  $("commonSummaryList").innerHTML = getCommonSummaries(getActiveSummaryScopeKey())
    .map((summary) => `<option value="${escapeAttr(summary)}"></option>`)
    .join("");
  renderSummaryMenu("desktopSummaryInput", "desktopSummaryMenu", "desktop");
  renderSummaryMenu("mobileSummaryInput", "mobileSummaryMenu", "mobile");
  updateSaveSummaryButtons();
}

function loadCommonSummaryStore() {
  const raw = readJsonStorage(COMMON_SUMMARY_STORAGE_KEY, {});
  if (Array.isArray(raw)) {
    return { global: raw };
  }
  return raw && typeof raw === "object" ? raw : {};
}

function getCommonSummaries(scopeKey) {
  const scoped = state.commonSummaries[scopeKey] || [];
  const fallback = scopeKey === "global" ? [] : state.commonSummaries.global || [];
  return (scoped.length ? scoped : fallback).filter(Boolean).slice(0, 6);
}

function saveCommonSummaries(scopeKey, summaries) {
  state.commonSummaries[scopeKey] = [...new Set(summaries.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 6);
  localStorage.setItem(COMMON_SUMMARY_STORAGE_KEY, JSON.stringify(state.commonSummaries));
  renderCommonSummaryOptions();
}

function saveSummaryFromInput(inputId, formKind) {
  const value = $(inputId).value.trim();
  const scopeKey = getSummaryScopeKey(formKind);
  if (!value || !scopeKey) {
    return;
  }
  const itemName = getSummaryScopeLabel(scopeKey);
  if (!window.confirm(`確定將「${value}」存為「${itemName}」的常用摘要嗎？`)) {
    return;
  }
  saveCommonSummaries(scopeKey, [value, ...getCommonSummaries(scopeKey).filter((summary) => summary !== value)]);
}

function bindSummaryInput(inputId, menuId, formKind) {
  const input = $(inputId);
  input.addEventListener("input", updateSaveSummaryButtons);
  input.addEventListener("focus", () => showSummaryMenu(inputId, menuId, formKind));
  input.addEventListener("click", () => showSummaryMenu(inputId, menuId, formKind));
}

function showSummaryMenu(inputId, menuId, formKind) {
  const scopeKey = getSummaryScopeKey(formKind);
  renderSummaryMenu(inputId, menuId, formKind);
  if (scopeKey && getCommonSummaries(scopeKey).length) {
    $(menuId).classList.remove("hidden");
  }
}

function hideSummaryMenus() {
  document.querySelectorAll(".summary-menu").forEach((menu) => menu.classList.add("hidden"));
}

function renderSummaryMenu(inputId, menuId, formKind) {
  const menu = $(menuId);
  const scopeKey = getSummaryScopeKey(formKind);
  menu.innerHTML = getCommonSummaries(scopeKey)
    .map((summary) => `<button type="button" data-summary="${escapeAttr(summary)}">${escapeHtml(summary)}</button>`)
    .join("");
  menu.querySelectorAll("[data-summary]").forEach((button) => {
    button.addEventListener("click", () => {
      $(inputId).value = button.dataset.summary || "";
      hideSummaryMenus();
      $(inputId).focus();
    });
  });
}

function openCommonSummaryModal(scopeKey = "") {
  state.commonSummaryEditingScopeKey = scopeKey || getActiveSummaryScopeKey();
  renderCommonSummaryFields();
  $("commonSummaryModal").classList.remove("hidden");
  $("commonSummaryModal").setAttribute("aria-hidden", "false");
  $("commonSummaryFields").querySelector("input")?.focus();
}

function closeCommonSummaryModal() {
  $("commonSummaryModal").classList.add("hidden");
  $("commonSummaryModal").setAttribute("aria-hidden", "true");
  state.commonSummaryEditingScopeKey = "";
}

function renderCommonSummaryFields() {
  const scopeKey = state.commonSummaryEditingScopeKey || getActiveSummaryScopeKey();
  const summaries = getCommonSummaries(scopeKey);
  const scopeLabel = getSummaryScopeLabel(scopeKey);
  $("commonSummaryTitle").textContent = `編輯常用摘要 - ${scopeLabel}`;
  $("commonSummaryFields").innerHTML = Array.from({ length: 6 }, (_, index) => {
    return `<label>
      ${escapeHtml(scopeLabel)} 常用摘要 ${index + 1}
      <input name="summary" value="${escapeAttr(summaries[index] || "")}" />
    </label>`;
  }).join("");
}

function saveCommonSummaryForm(event) {
  event.preventDefault();
  saveCommonSummaries(state.commonSummaryEditingScopeKey || getActiveSummaryScopeKey(), Array.from(new FormData(event.target).getAll("summary")));
  closeCommonSummaryModal();
}

function updateSaveSummaryButtons() {
  updateSaveSummaryButton("desktopSummaryInput", "desktopSaveSummaryBtn", "desktop");
  updateSaveSummaryButton("mobileSummaryInput", "mobileSaveSummaryBtn", "mobile");
}

function updateSaveSummaryButton(inputId, buttonId, formKind) {
  const hasText = Boolean($(inputId).value.trim());
  const hasScope = Boolean(getSummaryScopeKey(formKind));
  $(buttonId).disabled = !hasText || !hasScope;
}

function getActiveSummaryScopeKey() {
  return state.desktopMode ? getSummaryScopeKey("desktop") : getSummaryScopeKey("mobile");
}

function getSummaryScopeKey(formKind) {
  const destinationSelectId = formKind === "desktop" ? "desktopDestinationSelect" : "destinationSelect";
  const sourceSelectId = formKind === "desktop" ? "desktopSourceSelect" : "sourceSelect";
  return getSummaryScopeKeyFromValues($(destinationSelectId).value, $(sourceSelectId).value);
}

function getSummaryScopeKeyFromValues(destinationValue, sourceValue) {
  const destination = buildTransactionItem(String(destinationValue || ""));
  const source = buildTransactionItem(String(sourceValue || ""));
  if (destination.kind === "category" && destination.id) {
    return `${destination.kind}:${destination.id}`;
  }
  if (source.kind === "category" && source.id) {
    return `${source.kind}:${source.id}`;
  }
  return "";
}

function getSummaryScopeLabel(scopeKey) {
  if (!scopeKey) {
    return "目前項目";
  }
  const [kind, id] = scopeKey.split(":");
  return itemText(resolveTransactionItem({ kind, id }));
}

function getDesktopSettingsSummaryScopeKey() {
  const item = getDesktopSettingsItem(state.desktopSettingsSelectedId);
  if (!item) {
    return "";
  }
  if (item.collection === "accounts") {
    return "";
  }
  return `category:${item.id}`;
}

function renderSourceTypeOptions() {
  state.transactionSourceType = renderTransactionTypeOptions("sourceTypeSelect", state.transactionSourceType, [
    { value: "asset", label: "資產" },
    { value: "liability", label: "負債" },
    { value: "income", label: "收入" },
    { value: "nonOperatingIncome", label: "業外收入" },
    { value: "expense", label: "支出" },
    { value: "nonOperatingExpense", label: "業外支出" }
  ]);
}

function renderDesktopSourceTypeOptions() {
  renderTransactionTypeOptions("desktopSourceTypeSelect", state.transactionSourceType, [
    { value: "asset", label: "資產" },
    { value: "liability", label: "負債" },
    { value: "income", label: "收入" },
    { value: "nonOperatingIncome", label: "業外收入" },
    { value: "expense", label: "支出" },
    { value: "nonOperatingExpense", label: "業外支出" }
  ]);
}

function renderTransactionTypeOptions(selectId, selectedValue, options) {
  const select = $(selectId);
  const previousValue = select.value || selectedValue;
  select.innerHTML = options.map((option) => `<option value="${option.value}">${option.label}</option>`).join("");

  const nextValue = options.some((option) => option.value === previousValue) ? previousValue : options[0].value;
  select.value = nextValue;
  return nextValue;
}

function renderSourceItemOptions() {
  renderSourceItemOptionsFor("sourceTypeSelect", "sourceSelect");
}

function renderDesktopSourceItemOptions() {
  renderSourceItemOptionsFor("desktopSourceTypeSelect", "desktopSourceSelect");
}

function renderSourceItemOptionsFor(typeSelectId, itemSelectId) {
  const sourceSelect = $(itemSelectId);
  const previousValue = sourceSelect.value;
  const accountType = $(typeSelectId).value || state.transactionSourceType;
  const options =
    isIncomeCategoryType(accountType) || isExpenseCategoryType(accountType)
      ? state.categories
          .filter((category) => category.type === accountType)
          .sort(sortItemsByOrder)
          .map((category) => `<option value="${escapeAttr(`category:${category.id}`)}">${escapeHtml(category.name)}</option>`)
      : state.accounts
          .filter((account) => inferAccountType(account) === accountType)
          .sort(sortItemsByOrder)
          .map((account) => `<option value="${escapeAttr(`account:${account.id}`)}">${escapeHtml(account.name)}</option>`);

  sourceSelect.innerHTML = options.length ? options.join("") : '<option value="">沒有可選項目</option>';
  if (previousValue && Array.from(sourceSelect.options).some((option) => option.value === previousValue)) {
    sourceSelect.value = previousValue;
  }
  renderCommonSummaryOptions();
}

function renderDestinationTypeOptions() {
  state.transactionDestinationType = renderTransactionTypeOptions("destinationTypeSelect", state.transactionDestinationType, [
    { value: "asset", label: "資產" },
    { value: "liability", label: "負債" },
    { value: "expense", label: "支出" },
    { value: "nonOperatingExpense", label: "業外支出" }
  ]);
}

function renderDesktopDestinationTypeOptions() {
  renderTransactionTypeOptions("desktopDestinationTypeSelect", state.transactionDestinationType, [
    { value: "asset", label: "資產" },
    { value: "liability", label: "負債" },
    { value: "expense", label: "支出" },
    { value: "nonOperatingExpense", label: "業外支出" }
  ]);
}

function renderDestinationItemOptions(selectedType) {
  renderDestinationItemOptionsFor("destinationTypeSelect", "destinationSelect", selectedType);
}

function renderDesktopDestinationItemOptions(selectedType) {
  renderDestinationItemOptionsFor("desktopDestinationTypeSelect", "desktopDestinationSelect", selectedType);
}

function renderDestinationItemOptionsFor(typeSelectId, itemSelectId, selectedType) {
  const destinationSelect = $(itemSelectId);
  const previousValue = destinationSelect.value;
  const destinationType = selectedType || $(typeSelectId).value || state.transactionDestinationType;
  const options =
    isExpenseCategoryType(destinationType)
      ? state.categories
          .filter((category) => category.type === destinationType)
          .sort(sortItemsByOrder)
          .map((category) => `<option value="${escapeAttr(`category:${category.id}`)}">${escapeHtml(category.name)}</option>`)
      : state.accounts
          .filter((account) => inferAccountType(account) === destinationType)
          .sort(sortItemsByOrder)
          .map((account) => `<option value="${escapeAttr(`account:${account.id}`)}">${escapeHtml(account.name)}</option>`);

  destinationSelect.innerHTML = options.length ? options.join("") : '<option value="">沒有可選項目</option>';
  if (previousValue && Array.from(destinationSelect.options).some((option) => option.value === previousValue)) {
    destinationSelect.value = previousValue;
  }
  renderCommonSummaryOptions();
}

function setTodayDefault() {
  document.querySelectorAll('input[name="date"]').forEach((dateInput) => {
    if (!dateInput.value) {
      dateInput.value = todayKey();
    }
  });
  syncMobileDateField();
}

function bindMobileDateInputs() {
  const formDateInput = $("transactionForm")?.elements?.date;
  const headerDateInput = $("mobileHeaderDate");
  if (!formDateInput || !headerDateInput) {
    return;
  }

  headerDateInput.addEventListener("input", () => {
    formDateInput.value = headerDateInput.value;
  });
  formDateInput.addEventListener("input", () => {
    headerDateInput.value = formDateInput.value;
  });
  syncMobileDateField();
}

function syncMobileDateField() {
  const formDateInput = $("transactionForm")?.elements?.date;
  const headerDateInput = $("mobileHeaderDate");
  if (!formDateInput || !headerDateInput) {
    return;
  }

  headerDateInput.value = formDateInput.value;
}

function buildTransactionItem(value) {
  const [kind, id] = value.split(":");
  const resolved = resolveTransactionItem({ kind, id });
  return {
    kind,
    id,
    name: resolved.name || "",
    type: resolved.type || ""
  };
}

function getTransactionType(transaction) {
  const fromType = getCategoryFlowType(getTransactionFromItem(transaction).type);
  const toType = getCategoryFlowType(getTransactionToItem(transaction).type);
  const routeTypeMap = {
    asset: {
      asset: "transfer",
      liability: "payment",
      expense: "expense"
    },
    liability: {
      asset: "advance",
      liability: "transfer",
      expense: "expense"
    },
    expense: {
      asset: "refund",
      liability: "refund"
    },
    income: {
      asset: "income",
      liability: "payment",
      expense: "expense"
    }
  };

  return routeTypeMap[fromType]?.[toType] || "transfer";
}

function getTransactionFromItem(transaction) {
  return resolveTransactionItem(transaction.fromItem);
}

function getTransactionToItem(transaction) {
  return resolveTransactionItem(transaction.toItem);
}

function accountItem(id) {
  return {
    kind: "account",
    id: id || ""
  };
}

function categoryItem(id) {
  return {
    kind: "category",
    id: id || ""
  };
}

function emptyTransactionItem() {
  return {
    kind: "",
    id: "",
    name: "",
    type: ""
  };
}

function resolveTransactionItem(item) {
  if (!item?.kind || !item?.id) {
    return emptyTransactionItem();
  }

  if (item.kind === "account") {
    const account = state.accounts.find((accountItem) => accountItem.id === item.id);
    return {
      kind: "account",
      id: item.id,
      name: account?.name || item.name || "",
      type: account ? inferAccountType(account) : item.type || ""
    };
  }

  if (item.kind === "category") {
    const category = state.categories.find((categoryItem) => categoryItem.id === item.id);
    return {
      kind: "category",
      id: item.id,
      name: category?.name || item.name || "",
      type: category?.type || item.type || ""
    };
  }

  return emptyTransactionItem();
}

function transactionTypeText(transaction) {
  const type = getTransactionType(transaction);
  if (type === "expense") {
    return "支出";
  }
  if (type === "income") {
    return "收入";
  }
  if (type === "payment") {
    return "支付";
  }
  if (type === "advance") {
    return "預借";
  }
  if (type === "refund") {
    return "退款";
  }
  return "轉帳";
}

function isIncomeCategoryType(type) {
  return type === "income" || type === "nonOperatingIncome";
}

function isExpenseCategoryType(type) {
  return type === "expense" || type === "nonOperatingExpense";
}

function getCategoryFlowType(type) {
  if (isIncomeCategoryType(type)) {
    return "income";
  }
  if (isExpenseCategoryType(type)) {
    return "expense";
  }
  return type;
}

function itemText(item) {
  return item?.name || "-";
}

function isValidTransactionRoute(fromItem, toItem) {
  const fromType = resolveTransactionItem(fromItem).type;
  const toType = resolveTransactionItem(toItem).type;
  return Boolean(fromType && toType);
}

function isValidTransactionPayload(transaction) {
  return isValidDateKey(transaction.date) && Number.isFinite(transaction.amount) && transaction.amount > 0;
}

function isValidDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function normalizeImportedDate(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (isValidDateKey(text)) {
    return text;
  }
  const match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (!match) {
    return text;
  }
  const [, year, month, day] = match;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function buildAccountBalances(maxMonth = "") {
  const cacheKey = `${state.derivedDataRevision}:${maxMonth || "*"}`;
  const cached = state.derivedDataCache.accountBalances.get(cacheKey);
  if (cached) {
    return cached;
  }

  const snapshot = maxMonth ? getMonthlySnapshot(maxMonth) : getLatestUsableSnapshotBefore("9999-99");
  const snapshotMonth = snapshot?.month || "";
  const balances = Object.fromEntries(state.accounts.map((account) => [account.id, Number(account.balance || 0)]));

  if (snapshot?.closingBalances) {
    state.accounts.forEach((account) => {
      balances[account.id] = Number(snapshot.closingBalances?.[account.id] ?? balances[account.id] ?? 0);
    });
  }

  for (const transaction of state.transactions) {
    const transactionMonth = monthKey(transaction.date);
    if (snapshotMonth && transactionMonth <= snapshotMonth) {
      continue;
    }
    if (maxMonth && transactionMonth > maxMonth) {
      continue;
    }

    const amount = Number(transaction.amount || 0);
    const type = getTransactionType(transaction);
    const fromItem = getTransactionFromItem(transaction);
    const toItem = getTransactionToItem(transaction);

    if (type === "expense" && fromItem.kind === "account") {
      balances[fromItem.id] = (balances[fromItem.id] || 0) + (fromItem.type === "liability" ? amount : -amount);
    }
    if (type === "income" && toItem.kind === "account") {
      balances[toItem.id] = (balances[toItem.id] || 0) + amount;
    }
    if (type === "refund" && toItem.kind === "account") {
      balances[toItem.id] = (balances[toItem.id] || 0) + (toItem.type === "liability" ? -amount : amount);
    }
    if (type === "payment") {
      if (fromItem.kind === "account") {
        balances[fromItem.id] = (balances[fromItem.id] || 0) - amount;
      }
      if (toItem.kind === "account") {
        balances[toItem.id] = (balances[toItem.id] || 0) - amount;
      }
    }
    if (type === "advance") {
      if (fromItem.kind === "account") {
        balances[fromItem.id] = (balances[fromItem.id] || 0) + amount;
      }
      if (toItem.kind === "account") {
        balances[toItem.id] = (balances[toItem.id] || 0) + amount;
      }
    }
    if (type === "transfer") {
      if (fromItem.kind === "account") {
        balances[fromItem.id] = (balances[fromItem.id] || 0) - amount;
      }
      if (toItem.kind === "account") {
        balances[toItem.id] = (balances[toItem.id] || 0) + amount;
      }
    }
  }

  state.derivedDataCache.accountBalances.set(cacheKey, balances);
  return balances;
}

function getSnapshotMonthIncome(snapshotMonth) {
  return Number(getMonthlySnapshot(snapshotMonth)?.incomeTotal || 0);
}

function getSnapshotMonthExpense(snapshotMonth) {
  return Number(getMonthlySnapshot(snapshotMonth)?.expenseTotal || 0);
}

function getSnapshotCategoryTotal(snapshotMonth, categoryId) {
  return Number(getMonthlySnapshot(snapshotMonth)?.categoryTotals?.[categoryId] || 0);
}

function renderOverview() {
  const currentMonth = currentMonthKey();
  const currentSnapshot = getMonthlySnapshot(currentMonth);
  const balances = currentSnapshot ? null : buildAccountBalances();
  const netWorth = currentSnapshot
    ? Number(currentSnapshot.netWorth || 0)
    : state.accounts.reduce((sum, account) => {
        const value = Number((balances || {})[account.id] || 0);
        return sum + (inferAccountType(account) === "liability" ? -value : value);
      }, 0);
  $("netWorth").textContent = fmt(netWorth);

  const monthIncome = currentSnapshot
    ? getSnapshotMonthIncome(currentMonth)
    : state.transactions
        .filter((transaction) => monthKey(transaction.date) === currentMonth && getTransactionType(transaction) === "income")
        .reduce((sum, transaction) => sum + transaction.amount, 0);
  const monthExpense = currentSnapshot
    ? getSnapshotMonthExpense(currentMonth)
    : state.transactions
        .filter(
          (transaction) =>
            monthKey(transaction.date) === currentMonth &&
            (getTransactionType(transaction) === "expense" || getTransactionType(transaction) === "refund")
        )
        .reduce((sum, transaction) => sum + (getTransactionType(transaction) === "refund" ? -transaction.amount : transaction.amount), 0);

  $("monthIncome").textContent = fmt(monthIncome);
  $("monthExpense").textContent = fmt(monthExpense);

  renderBudget(monthExpense);
}

function renderBudget(monthExpense) {
  const budget = Number(state.settings.monthlyBudget || 0);
  $("budgetCard").classList.toggle("hidden", !budget);
  if (!budget) {
    $("budgetText").textContent = "尚未設定每月預算";
    $("budgetFill").style.width = "0%";
    return;
  }

  const ratio = Math.min(100, Math.round((monthExpense / budget) * 100));
  $("budgetFill").style.width = `${ratio}%`;
  $("budgetFill").style.background =
    ratio >= 90 ? "var(--danger)" : ratio >= 75 ? "var(--warn)" : "var(--success)";
  $("budgetText").textContent = `已使用 ${ratio}% (${fmt(monthExpense)} / ${fmt(budget)})`;
}

function renderTransactions() {
  const transactions = getFilteredTransactions();
  renderTransactionHeaders();
  const bodyRenderKey = getTransactionTableBodyRenderKey();
  let didRerenderBody = false;
  if (state.transactionTableBodyRenderKey !== bodyRenderKey) {
    $("transactionTableBody").innerHTML =
      state.transactionEditMode
        ? renderEditableTransactions(transactions)
        : renderReadonlyTransactions(transactions);
    state.transactionTableBodyRenderKey = bodyRenderKey;
    didRerenderBody = true;
  }

  if (!state.transactionEditMode) {
    updateReadonlyTransactionSelectionUi(didRerenderBody);
  }
  renderMobileTransactionActions();
  renderDesktopTransactionActions();
}

function renderTransactionHeaders() {
  const headerRow = document.querySelector("#transactions thead tr");
  if (!headerRow) {
    return;
  }

  const renderKey = getTransactionTableHeaderRenderKey();
  if (state.transactionTableHeaderRenderKey === renderKey) {
    return;
  }

  const showBalance = shouldShowDesktopBalanceColumn();

  headerRow.innerHTML = state.desktopMode
    ? `
      <th>日期(星期)</th>
      <th>從項目</th>
      <th>類型</th>
      <th>至項目</th>
      <th>金額</th>
      <th>摘要</th>
      ${showBalance ? "<th>餘額</th>" : ""}
    `
    : `
      <th>日期(星期)</th>
      <th>從項目</th>
      <th>類型</th>
      <th>至項目</th>
      <th>金額</th>
      <th>摘要</th>
    `;
  state.transactionTableHeaderRenderKey = renderKey;
}

function getTransactionTableHeaderRenderKey() {
  return `${state.desktopMode ? "desktop" : "mobile"}:${shouldShowDesktopBalanceColumn() ? "balance" : "plain"}`;
}

function getTransactionTableBodyRenderKey() {
  const modeKey = state.desktopMode ? `desktop:${state.desktopDate}:${getDesktopSidebarSelectionCacheKey()}` : `mobile:${state.transactionRange}`;
  const editKey = state.transactionEditMode ? "edit" : "readonly";
  const balanceKey = shouldShowDesktopBalanceColumn() ? "balance" : "plain";
  return `${state.derivedDataRevision}:${modeKey}:${editKey}:${balanceKey}`;
}

function renderDesktopTransactionActions() {
  const hasSelection = Boolean(getSelectedDesktopTransaction());
  const renderKey = `${state.transactionEditMode ? "edit" : "readonly"}:${hasSelection ? "selected" : "empty"}`;
  if (state.desktopTransactionActionsRenderKey === renderKey) {
    return;
  }

  $("desktopEditBtn").classList.toggle("hidden", state.transactionEditMode);
  $("desktopSaveBtn").classList.toggle("hidden", !state.transactionEditMode);
  $("desktopCancelEditBtn").classList.toggle("hidden", !state.transactionEditMode);
  $("desktopAddBtn").disabled = state.transactionEditMode;
  $("desktopSettingsBtn").disabled = state.transactionEditMode;
  $("desktopEditRecordBtn").disabled = state.transactionEditMode || !hasSelection;
  $("desktopDeleteBtn").disabled = state.transactionEditMode || !hasSelection;
  $("desktopEditBtn").disabled = false;
  $("desktopSaveBtn").disabled = false;
  $("desktopCancelEditBtn").disabled = false;
  state.desktopTransactionActionsRenderKey = renderKey;
}

function renderMobileTransactionActions() {
  const hasSelection = Boolean(getSelectedMobileTransaction());
  const renderKey = hasSelection ? "selected" : "empty";
  if (state.mobileTransactionActionsRenderKey === renderKey) {
    return;
  }
  $("mobileEditTransactionBtn").disabled = !hasSelection;
  $("mobileDeleteTransactionBtn").disabled = !hasSelection;
  state.mobileTransactionActionsRenderKey = renderKey;
}

function renderReadonlyTransactions(transactions) {
  if (state.desktopMode) {
    return renderDesktopReadonlyTransactions(transactions);
  }

  return (
    transactions
      .map((transaction) => {
        return `<tr class="mobile-transaction-row" data-transaction-id="${escapeAttr(transaction.id)}" tabindex="0">
          <td>${escapeHtml(formatDesktopDateCell(transaction.date))}</td>
          <td>${escapeHtml(itemText(getTransactionFromItem(transaction)))}</td>
          <td>${transactionTypeText(transaction)}</td>
          <td>${escapeHtml(itemText(getTransactionToItem(transaction)))}</td>
          <td>${fmt(transaction.amount)}</td>
          <td>${escapeHtml(transaction.note || "-")}</td>
        </tr>`;
      })
      .join("") ||
    '<tr><td colspan="6">目前還沒有記錄資料。</td></tr>'
  );
}

function renderEditableTransactions(transactions) {
  if (state.desktopMode) {
    return renderDesktopEditableTransactions(transactions);
  }

  return (
    transactions
      .map((transaction) => {
        return `<tr data-transaction-id="${escapeAttr(transaction.id)}" class="editable-row">
          <td><input name="date" type="date" value="${escapeAttr(transaction.date)}" /></td>
          <td>${transactionTypeText(transaction)}</td>
          <td><input name="amount" type="number" min="1" step="1" value="${escapeAttr(transaction.amount)}" /></td>
          <td>${escapeHtml(itemText(getTransactionFromItem(transaction)))}</td>
          <td>${escapeHtml(itemText(getTransactionToItem(transaction)))}</td>
          <td><input name="note" list="commonSummaryList" value="${escapeAttr(transaction.note || "")}" /></td>
        </tr>`;
      })
      .join("") ||
    '<tr><td colspan="6">目前還沒有記錄資料。</td></tr>'
  );
}

function renderDesktopEditableTransactions(transactions) {
  const balanceMap = buildDesktopBalanceMap();
  const showBalance = shouldShowDesktopBalanceColumn();
  const emptyColspan = showBalance ? 7 : 6;

  return (
    transactions
      .map((transaction) => {
        const fromItem = getTransactionFromItem(transaction);
        const toItem = getTransactionToItem(transaction);
        return `<tr data-transaction-id="${escapeAttr(transaction.id)}" class="editable-row desktop-editable-row">
          <td><input name="date" type="date" value="${escapeAttr(transaction.date)}" /></td>
          <td>${renderDesktopItemEditor("from", fromItem)}</td>
          <td class="desktop-type-preview">${transactionTypeText(transaction)}</td>
          <td>${renderDesktopItemEditor("to", toItem)}</td>
          <td><input name="amount" type="number" min="1" step="1" value="${escapeAttr(transaction.amount)}" /></td>
          <td><input name="note" list="commonSummaryList" value="${escapeAttr(transaction.note || "")}" /></td>
          ${showBalance ? `<td>${fmt(balanceMap[transaction.id] ?? 0)}</td>` : ""}
        </tr>`;
      })
      .join("") ||
    `<tr><td colspan="${emptyColspan}">目前還沒有記錄資料。</td></tr>`
  );
}

function renderDesktopItemEditor(prefix, item) {
  const typeOptions =
    prefix === "from"
      ? [
          ["asset", "資產"],
          ["liability", "負債"],
          ["income", "收入"],
          ["nonOperatingIncome", "業外收入"]
        ]
      : [
          ["asset", "資產"],
          ["liability", "負債"],
          ["expense", "支出"],
          ["nonOperatingExpense", "業外支出"]
        ];
  const selectedType = item.type || typeOptions[0][0];

  return `<div class="desktop-table-split">
    <select name="${prefix}Type">${renderInlineOptions(typeOptions, selectedType)}</select>
    <select name="${prefix}Id">${renderTransactionItemOptions(selectedType, transactionItemValue(item))}</select>
  </div>`;
}

function renderInlineOptions(options, selectedValue) {
  return options
    .map(([value, label]) => `<option value="${value}" ${value === selectedValue ? "selected" : ""}>${label}</option>`)
    .join("");
}

function getTransactionOptionItems(type) {
  const cacheKey = `${state.derivedDataRevision}:${type}`;
  const cached = state.derivedDataCache.transactionOptionItems.get(cacheKey);
  if (cached) {
    return cached;
  }

  const items =
    isIncomeCategoryType(type) || isExpenseCategoryType(type)
      ? state.categories
          .filter((category) => category.type === type)
          .sort(sortItemsByOrder)
          .map((category) => ({ value: `category:${category.id}`, name: category.name }))
      : state.accounts
          .filter((account) => inferAccountType(account) === type)
          .sort(sortItemsByOrder)
          .map((account) => ({ value: `account:${account.id}`, name: account.name }));

  state.derivedDataCache.transactionOptionItems.set(cacheKey, items);
  return items;
}

function renderTransactionItemOptions(type, selectedValue = "") {
  const items = getTransactionOptionItems(type);

  return items.length
    ? items
        .map(
          (item) =>
            `<option value="${escapeAttr(item.value)}" ${item.value === selectedValue ? "selected" : ""}>${escapeHtml(item.name)}</option>`
        )
        .join("")
    : '<option value="">沒有可選項目</option>';
}

function renderDesktopReadonlyTransactions(transactions) {
  const balanceMap = buildDesktopBalanceMap();
  const showBalance = shouldShowDesktopBalanceColumn();
  const emptyColspan = showBalance ? 7 : 6;

  return (
    transactions
      .map((transaction) => {
        return `<tr class="desktop-transaction-row" data-transaction-id="${escapeAttr(transaction.id)}" tabindex="0">
          <td>${escapeHtml(formatDesktopDateCell(transaction.date))}</td>
          <td>${escapeHtml(itemText(getTransactionFromItem(transaction)))}</td>
          <td>${transactionTypeText(transaction)}</td>
          <td>${escapeHtml(itemText(getTransactionToItem(transaction)))}</td>
          <td>${fmt(transaction.amount)}</td>
          <td>${escapeHtml(transaction.note || "-")}</td>
          ${showBalance ? `<td>${fmt(balanceMap[transaction.id] ?? 0)}</td>` : ""}
        </tr>`;
      })
      .join("") ||
    `<tr><td colspan="${emptyColspan}">目前還沒有記錄資料。</td></tr>`
  );
}

function updateReadonlyTransactionSelectionUi(forceFullSync = false) {
  const nextUiState = {
    mobileSelectedId: state.mobileSelectedTransactionId,
    desktopSelectedId: state.desktopSelectedTransactionId
  };

  if (forceFullSync) {
    document.querySelectorAll("#transactionTableBody .mobile-transaction-row").forEach((row) => {
      row.classList.toggle("selected", (row.dataset.transactionId || "") === nextUiState.mobileSelectedId);
    });
    document.querySelectorAll("#transactionTableBody .desktop-transaction-row").forEach((row) => {
      row.classList.toggle("selected", (row.dataset.transactionId || "") === nextUiState.desktopSelectedId);
    });
  } else {
    if (state.readonlyTransactionSelectionUiState.mobileSelectedId !== nextUiState.mobileSelectedId) {
      setReadonlyTransactionRowSelected("mobile", state.readonlyTransactionSelectionUiState.mobileSelectedId, false);
      setReadonlyTransactionRowSelected("mobile", nextUiState.mobileSelectedId, true);
    }
    if (state.readonlyTransactionSelectionUiState.desktopSelectedId !== nextUiState.desktopSelectedId) {
      setReadonlyTransactionRowSelected("desktop", state.readonlyTransactionSelectionUiState.desktopSelectedId, false);
      setReadonlyTransactionRowSelected("desktop", nextUiState.desktopSelectedId, true);
    }
  }

  state.readonlyTransactionSelectionUiState = nextUiState;
}

function setReadonlyTransactionRowSelected(mode, transactionId, selected) {
  if (!transactionId) {
    return;
  }
  const className = mode === "mobile" ? "mobile-transaction-row" : "desktop-transaction-row";
  const row = document.querySelector(
    `#transactionTableBody .${className}[data-transaction-id="${CSS.escape(transactionId)}"]`
  );
  if (row) {
    row.classList.toggle("selected", selected);
  }
}

function updateDesktopEditableItemOptions(row, prefix) {
  const type = row.querySelector(`[name="${prefix}Type"]`).value;
  const itemSelect = row.querySelector(`[name="${prefix}Id"]`);
  itemSelect.innerHTML = renderTransactionItemOptions(type);
}

function updateDesktopEditableTypePreview(row) {
  const transaction = buildTransactionFromEditableRow(row);
  row.querySelector(".desktop-type-preview").textContent = transactionTypeText(transaction);
}

function getDesktopDestinationName(transaction) {
  return itemText(getTransactionToItem(transaction));
}

function formatDesktopDateCell(dateText) {
  if (!isValidDateKey(dateText)) {
    return String(dateText || "-");
  }
  const date = new Date(`${dateText}T00:00:00`);
  const weekday = new Intl.DateTimeFormat("zh-TW", { weekday: "short" }).format(date);
  return `${dateText} (${weekday})`;
}

function buildDesktopBalanceMap() {
  const scope = getDesktopBalanceScope();
  if (!scope) {
    return {};
  }

  const cacheKey = `${state.derivedDataRevision}:${state.desktopDate}:${getDesktopBalanceScopeCacheKey(scope)}`;
  const cached = state.derivedDataCache.desktopBalanceMaps.get(cacheKey);
  if (cached) {
    return cached;
  }

  const runningMap = {};
  let runningBalance = getDesktopBalanceStart(scope, state.desktopDate);
  const snapshotMonth = getLatestUsableSnapshotBefore(state.desktopDate)?.month || "";
  const sortedTransactions = state.transactions
    .filter((transaction) => {
      const transactionMonth = monthKey(transaction.date);
      return (!snapshotMonth || transactionMonth > snapshotMonth) && transactionMonth <= state.desktopDate;
    })
    .sort(compareTransactionsAscending);

  sortedTransactions.forEach((transaction) => {
    runningBalance += getDesktopBalanceDelta(transaction, scope);
    if (monthKey(transaction.date) === state.desktopDate) {
      runningMap[transaction.id] = runningBalance;
    }
  });

  state.derivedDataCache.desktopBalanceMaps.set(cacheKey, runningMap);
  return runningMap;
}

function getDesktopBalanceScopeCacheKey(scope) {
  if (scope.mode === "account") {
    return `account:${scope.id}`;
  }
  if (scope.mode === "type-total") {
    return `type-total:${scope.type}`;
  }
  return scope.mode;
}

function shouldShowDesktopBalanceColumn() {
  return Boolean(getDesktopBalanceScope());
}

function getDesktopBalanceScope() {
  const selection = state.desktopSidebarSelection;
  if (!selection) {
    return { mode: "type-total", type: "asset" };
  }

  if (selection.kind === "group") {
    if (selection.type === "asset" || selection.type === "liability") {
      return { mode: "type-total", type: selection.type };
    }
    return null;
  }

  if (selection.kind === "netWorth") {
    return { mode: "net-worth" };
  }

  if (selection.kind === "item" && selection.itemKind === "account") {
    return { mode: "account", id: selection.id };
  }

  return null;
}

function getDesktopBalanceStart(scope, targetMonth = "") {
  const snapshot = targetMonth ? getLatestUsableSnapshotBefore(targetMonth) : null;
  if (scope.mode === "account") {
    if (snapshot?.closingBalances) {
      return Number(snapshot.closingBalances?.[scope.id] || 0);
    }
    const account = state.accounts.find((item) => item.id === scope.id);
    return Number(account?.balance || 0);
  }

  if (scope.mode === "net-worth") {
    if (snapshot) {
      return Number(snapshot.netWorth || 0);
    }
    const assetTotal = state.accounts
      .filter((account) => inferAccountType(account) === "asset")
      .reduce((sum, account) => sum + Number(account.balance || 0), 0);
    const liabilityTotal = state.accounts
      .filter((account) => inferAccountType(account) === "liability")
      .reduce((sum, account) => sum + Number(account.balance || 0), 0);
    return assetTotal - liabilityTotal;
  }

  if (snapshot?.closingBalances) {
    return state.accounts
      .filter((account) => inferAccountType(account) === scope.type)
      .reduce((sum, account) => sum + Number(snapshot.closingBalances?.[account.id] || 0), 0);
  }

  return state.accounts
    .filter((account) => inferAccountType(account) === scope.type)
    .reduce((sum, account) => sum + Number(account.balance || 0), 0);
}

function getDesktopBalanceDelta(transaction, scope) {
  if (scope.mode === "account") {
    return getAccountDelta(transaction, scope.id);
  }

  if (scope.mode === "net-worth") {
    const assetDelta = state.accounts
      .filter((account) => inferAccountType(account) === "asset")
      .reduce((sum, account) => sum + getAccountDelta(transaction, account.id), 0);
    const liabilityDelta = state.accounts
      .filter((account) => inferAccountType(account) === "liability")
      .reduce((sum, account) => sum + getAccountDelta(transaction, account.id), 0);
    return assetDelta - liabilityDelta;
  }

  return state.accounts
    .filter((account) => inferAccountType(account) === scope.type)
    .reduce((sum, account) => sum + getAccountDelta(transaction, account.id), 0);
}

function getAccountDelta(transaction, accountId) {
  const amount = Number(transaction.amount || 0);
  const type = getTransactionType(transaction);
  const fromItem = getTransactionFromItem(transaction);
  const toItem = getTransactionToItem(transaction);
  let delta = 0;

  if (type === "expense" && fromItem.kind === "account" && fromItem.id === accountId) {
    delta += fromItem.type === "liability" ? amount : -amount;
  }

  if (type === "income" && toItem.kind === "account" && toItem.id === accountId) {
    delta += amount;
  }

  if (type === "refund" && toItem.kind === "account" && toItem.id === accountId) {
    delta += toItem.type === "liability" ? -amount : amount;
  }

  if (type === "payment") {
    if (fromItem.kind === "account" && fromItem.id === accountId) {
      delta -= amount;
    }
    if (toItem.kind === "account" && toItem.id === accountId) {
      delta -= amount;
    }
  }

  if (type === "advance") {
    if (fromItem.kind === "account" && fromItem.id === accountId) {
      delta += amount;
    }
    if (toItem.kind === "account" && toItem.id === accountId) {
      delta += amount;
    }
  }

  if (type === "transfer") {
    if (fromItem.kind === "account" && fromItem.id === accountId) {
      delta -= amount;
    }
    if (toItem.kind === "account" && toItem.id === accountId) {
      delta += amount;
    }
  }

  return delta;
}

function matchesDesktopSidebarSelection(transaction) {
  const selection = state.desktopSidebarSelection;
  if (!selection) {
    return true;
  }

  if (selection.kind === "netWorth") {
    return true;
  }

  const fromItem = getTransactionFromItem(transaction);
  const toItem = getTransactionToItem(transaction);

  if (selection.kind === "group") {
    return fromItem.type === selection.type || toItem.type === selection.type;
  }

  return (
    (fromItem.kind === selection.itemKind && fromItem.id === selection.id) ||
    (toItem.kind === selection.itemKind && toItem.id === selection.id)
  );
}

function renderSelectOptions(items, selectedId) {
  return items
    .map(
      (item) =>
        `<option value="${escapeAttr(item.id)}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.name)}</option>`
    )
    .join("");
}

async function saveEditedTransactions() {
  const rows = Array.from(document.querySelectorAll("#transactionTableBody tr[data-transaction-id]"));
  let dirtyMonth = "";

  for (const row of rows) {
    const transaction = state.transactions.find((item) => item.id === row.dataset.transactionId);
    if (!transaction) {
      continue;
    }

    const payload = state.desktopMode
      ? buildTransactionFromEditableRow(row)
      : {
          date: row.querySelector('[name="date"]').value,
          fromItem: compactTransactionItem(getTransactionFromItem(transaction)),
          toItem: compactTransactionItem(getTransactionToItem(transaction)),
          amount: Number(row.querySelector('[name="amount"]').value || 0),
          note: row.querySelector('[name="note"]').value
        };

    if (!isValidTransactionRoute(payload.fromItem, payload.toItem)) {
      showMessage("列表中有不成立的記錄組合，請修正後再儲存。", "資料錯誤");
      return;
    }
    if (!isValidTransactionPayload(payload)) {
      showMessage("列表中有日期或金額格式不正確的資料，請修正後再儲存。", "資料錯誤");
      return;
    }

    await saveUserCollectionDocument(db, state.uid, "transactions", row.dataset.transactionId, payload);
    dirtyMonth = earlierMonth(dirtyMonth, earlierMonth(monthKey(transaction.date), monthKey(payload.date)));
  }

  await markSnapshotDirtyFromMonth(dirtyMonth);
  state.transactionEditMode = false;
  await loadAll();
  renderAll();
}

function buildTransactionFromEditableRow(row) {
  return {
    date: row.querySelector('[name="date"]').value,
    fromItem: buildTransactionItem(row.querySelector('[name="fromId"]').value),
    toItem: buildTransactionItem(row.querySelector('[name="toId"]').value),
    amount: Number(row.querySelector('[name="amount"]').value || 0),
    note: row.querySelector('[name="note"]').value
  };
}

function compactTransactionItem(item) {
  return {
    kind: item?.kind || "",
    id: item?.id || "",
    name: item?.name || "",
    type: item?.type || ""
  };
}

function getFilteredTransactions() {
  const cacheKey = `${state.derivedDataRevision}:${getFilteredTransactionsCacheKey()}`;
  const cached = state.derivedDataCache.filteredTransactions.get(cacheKey);
  if (cached) {
    return cached;
  }

  let result;
  if (state.desktopMode) {
    result = state.transactions
      .filter((transaction) => monthKey(transaction.date) === state.desktopDate)
      .filter(matchesDesktopSidebarSelection)
      .sort(compareTransactionsAscending);
    state.derivedDataCache.filteredTransactions.set(cacheKey, result);
    return result;
  }

  if (state.transactionRange === "all") {
    result = state.transactions;
    state.derivedDataCache.filteredTransactions.set(cacheKey, result);
    return result;
  }

  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const start = new Date(end);

  if (state.transactionRange === "week") {
    start.setDate(start.getDate() - 6);
  } else if (state.transactionRange === "month") {
    start.setMonth(start.getMonth() - 1);
    start.setDate(start.getDate() + 1);
  } else if (state.transactionRange === "quarter") {
    start.setMonth(start.getMonth() - 3);
    start.setDate(start.getDate() + 1);
  }

  start.setHours(0, 0, 0, 0);

  result = state.transactions.filter((transaction) => {
    const date = new Date(`${transaction.date}T00:00:00`);
    return date >= start && date <= end;
  });
  state.derivedDataCache.filteredTransactions.set(cacheKey, result);
  return result;
}

function compareTransactionsAscending(a, b) {
  const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
  if (dateCompare !== 0) {
    return dateCompare;
  }
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function getFilteredTransactionsCacheKey() {
  if (state.desktopMode) {
    return `desktop:${state.desktopDate}:${getDesktopSidebarSelectionCacheKey()}`;
  }
  return `mobile:${state.transactionRange}`;
}

function getDesktopSidebarSelectionCacheKey() {
  const selection = state.desktopSidebarSelection;
  if (!selection) {
    return "all";
  }
  if (selection.kind === "group") {
    return `group:${selection.key}`;
  }
  if (selection.kind === "item") {
    return `item:${selection.itemKind}:${selection.id}`;
  }
  return selection.kind;
}

function buildChartData() {
  const currentMonth = currentMonthKey();
  const cacheKey = `${state.derivedDataRevision}:${currentMonth}`;
  const cached = state.derivedDataCache.chartData.get(cacheKey);
  if (cached) {
    return cached;
  }

  const currentSnapshot = getMonthlySnapshot(currentMonth);
  const byCategory = {};
  if (currentSnapshot) {
    Object.entries(currentSnapshot.categoryTotals || {}).forEach(([categoryId, amount]) => {
      const category = state.categories.find((item) => item.id === categoryId);
      if (!category || !isExpenseCategoryType(category.type)) {
        return;
      }
      byCategory[category?.name || "未分類"] = Number(amount || 0);
    });
  } else {
    const monthTransactions = state.transactions.filter(
      (transaction) =>
        monthKey(transaction.date) === currentMonth &&
        (getTransactionType(transaction) === "expense" || getTransactionType(transaction) === "refund")
    );

    monthTransactions.forEach((transaction) => {
      const type = getTransactionType(transaction);
      const categoryName = itemText(type === "refund" ? getTransactionFromItem(transaction) : getTransactionToItem(transaction)) || "未分類";
      byCategory[categoryName] = (byCategory[categoryName] || 0) + (type === "refund" ? -transaction.amount : transaction.amount);
    });
  }

  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setMonth(date.getMonth() - (5 - index));
    return currentMonthKey(date);
  });

  const incomeSeries = months.map((month) =>
    getMonthlySnapshot(month)
      ? getSnapshotMonthIncome(month)
      : state.transactions
          .filter((transaction) => monthKey(transaction.date) === month && getTransactionType(transaction) === "income")
          .reduce((sum, transaction) => sum + transaction.amount, 0)
  );

  const expenseSeries = months.map((month) =>
    getMonthlySnapshot(month)
      ? getSnapshotMonthExpense(month)
      : state.transactions
          .filter((transaction) => monthKey(transaction.date) === month && (getTransactionType(transaction) === "expense" || getTransactionType(transaction) === "refund"))
          .reduce((sum, transaction) => sum + (getTransactionType(transaction) === "refund" ? -transaction.amount : transaction.amount), 0)
  );

  const chartData = {
    pieData: {
      labels: Object.keys(byCategory),
      datasets: [
        {
          data: Object.values(byCategory),
          backgroundColor: ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#0891b2", "#7c3aed"]
        }
      ]
    },
    barData: {
      labels: months,
      datasets: [
        {
          label: "收入",
          data: incomeSeries,
          backgroundColor: "#16a34a"
        },
        {
          label: "支出",
          data: expenseSeries,
          backgroundColor: "#dc2626"
        }
      ]
    }
  };

  state.derivedDataCache.chartData.set(cacheKey, chartData);
  return chartData;
}

function renderCharts() {
  const { pieData, barData } = buildChartData();

  if (state.pieChart) {
    state.pieChart.data = pieData;
    state.pieChart.update("none");
  } else {
    state.pieChart = new Chart($("pieChart"), {
      type: "pie",
      data: pieData,
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });
  }

  if (state.barChart) {
    state.barChart.data = barData;
    state.barChart.update("none");
    return;
  }

  state.barChart = new Chart($("barChart"), {
    type: "bar",
    data: barData,
    options: {
      responsive: true,
      maintainAspectRatio: false
    }
  });
}

function handleItemsTransfer() {
  if (isItemImportMode()) {
    $("itemsImportInput").click();
    return;
  }
  exportItemsCsv();
}

function isItemImportMode() {
  if (state.accounts.length === 0 && state.categories.length === 0) {
    return true;
  }
  if (state.hasTransactions) {
    return false;
  }
  const accountNames = new Set(PROTECTED_ITEMS.filter((item) => item.collection === "accounts").map((item) => item.name));
  const categoryNames = new Set(DEFAULT_CATEGORIES.map((item) => `${item.type}:${item.name}`));
  return (
    state.accounts.every((account) => accountNames.has(account.name)) &&
    state.categories.every((category) => categoryNames.has(`${category.type}:${category.name}`))
  );
}

function exportItemsCsv() {
  const rows = [["類別", "項目名稱", "期初餘額", "次序", "保護項目", "ID", "常用摘要"]];

  state.accounts
    .map((account) => ({
      type: inferAccountType(account),
      name: account.name,
      balance: Number(account.balance || 0),
      order: getItemOrder(account),
      protected: isProtectedDataItem("accounts", account),
      id: account.id
    }))
    .sort(sortItemsByTypeAndOrder)
    .forEach((item) => {
      rows.push([
        desktopSettingsTypeLabel(item.type),
        item.name,
        item.balance,
        item.order,
        item.protected ? "是" : "否",
        item.id,
        ""
      ]);
    });

  state.categories
    .map((category) => ({
      type: category.type,
      name: category.name,
      balance: "",
      order: getItemOrder(category),
      protected: isProtectedDataItem("categories", category),
      id: category.id
    }))
    .sort(sortItemsByTypeAndOrder)
    .forEach((item) => {
      rows.push([
        desktopSettingsTypeLabel(item.type),
        item.name,
        item.balance,
        item.order,
        item.protected ? "是" : "否",
        item.id,
        getCommonSummaries(`category:${item.id}`).join("；")
      ]);
    });

  downloadCsv(rows, `items-${todayKey()}.csv`);
}

function sortItemsByTypeAndOrder(a, b) {
  const typeCompare = getItemTypeOrder(a.type) - getItemTypeOrder(b.type);
  if (typeCompare !== 0) {
    return typeCompare;
  }
  return sortItemsByOrder(a, b);
}

function getItemTypeOrder(type) {
  return {
    asset: 0,
    liability: 1,
    income: 2,
    expense: 3,
    nonOperatingIncome: 4,
    nonOperatingExpense: 5
  }[type] ?? 99;
}

async function importItemsCsv(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) {
    return;
  }
  if (!window.confirm("確定要匯入項目資料嗎？同名同類別項目會被更新。")) {
    return;
  }

  const rows = parseCsv(await file.text());
  const headers = rows.shift() || [];
  const requiredHeaders = ["類別", "項目名稱"];
  const missingHeaders = requiredHeaders.filter((header) => !headers.some((value) => String(value || "").trim() === header));
  if (missingHeaders.length) {
    showMessage(`匯入失敗：缺少欄位 ${missingHeaders.join("、")}。`, "匯入失敗");
    return;
  }

  const importedSummaries = [];
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let duplicateNameSkippedCount = 0;
  const duplicateNameSamples = [];
  for (const row of rows) {
    const record = rowToObject(headers, row);
    const type = itemTypeFromLabel(record["類別"]);
    const name = normalizeItemName(record["項目名稱"]);
    const order = parseNonNegativeInteger(record["次序"] || getNextItemOrder(type));
    if (!type || !name) {
      skippedCount += 1;
      continue;
    }
    if (order === null) {
      skippedCount += 1;
      continue;
    }
    const balance = parseFiniteNumber(record["期初餘額"] || 0);
    if (isDesktopAccountType(type) && balance === null) {
      skippedCount += 1;
      continue;
    }
    const summaries = String(record["常用摘要"] || "")
      .split(/[；;]/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (isDesktopAccountType(type)) {
      const existing = state.accounts.find((account) => inferAccountType(account) === type && account.name === name);
      const conflict = findConflictingItemByName(name, {
        excludeCollection: existing ? "accounts" : "",
        excludeId: existing?.id || ""
      });
      if (conflict) {
        skippedCount += 1;
        duplicateNameSkippedCount += 1;
        if (duplicateNameSamples.length < 10) {
          duplicateNameSamples.push(name);
        }
        continue;
      }
      const payload = { name, type, balance, order };
      if (existing) {
        await updateUserCollectionDocument(db, state.uid, "accounts", existing.id, payload);
        updatedCount += 1;
      } else {
        await createUserCollectionDocument(db, state.uid, "accounts", { ...payload, createdAt: Date.now() });
        createdCount += 1;
      }
      continue;
    }

    const existing = state.categories.find((category) => category.type === type && category.name === name);
    const conflict = findConflictingItemByName(name, {
      excludeCollection: existing ? "categories" : "",
      excludeId: existing?.id || ""
    });
    if (conflict) {
      skippedCount += 1;
      duplicateNameSkippedCount += 1;
      if (duplicateNameSamples.length < 10) {
        duplicateNameSamples.push(name);
      }
      continue;
    }
    const payload = { name, type, order };
    let categoryId = existing?.id || "";
    if (existing) {
      await updateUserCollectionDocument(db, state.uid, "categories", existing.id, payload);
      updatedCount += 1;
    } else {
      const itemRef = await createUserCollectionDocument(db, state.uid, "categories", { ...payload, createdAt: Date.now() });
      categoryId = itemRef.id;
      createdCount += 1;
    }
    if (categoryId) {
      importedSummaries.push({ key: `category:${categoryId}`, summaries });
    }
  }

  await loadAll();
  await normalizeAllItemOrders();
  importedSummaries.forEach((item) => {
    if (item.summaries.length) {
      state.commonSummaries[item.key] = item.summaries.slice(0, 6);
      return;
    }
    delete state.commonSummaries[item.key];
  });
  localStorage.setItem(COMMON_SUMMARY_STORAGE_KEY, JSON.stringify(state.commonSummaries));
  await loadAll();
  renderAll();
  renderDesktopSettings();
  const messages = [`項目匯入完成：新增 ${createdCount} 筆，更新 ${updatedCount} 筆，略過 ${skippedCount} 筆。`];
  if (duplicateNameSkippedCount > 0) {
    messages.push(`因項目名稱重複而略過 ${duplicateNameSkippedCount} 筆。`);
    messages.push(`重複名稱（前 10 筆）：${duplicateNameSamples.join("、")}`);
  }
  showMessage(messages.join("\n"), "項目匯入結果");
}

function detectCsvDelimiter(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sample = lines[0] || "";
  const counts = [
    { delimiter: ",", count: (sample.match(/,/g) || []).length },
    { delimiter: "\t", count: (sample.match(/\t/g) || []).length },
    { delimiter: ";", count: (sample.match(/;/g) || []).length }
  ].sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].delimiter : ",";
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const input = String(text || "").replace(/^\uFEFF/, "");
  const delimiter = detectCsvDelimiter(input);

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value !== "")) {
    rows.push(row);
  }
  return rows;
}

function rowToObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [String(header || "").trim(), row[index] ?? ""]));
}

function itemTypeFromLabel(label) {
  const value = String(label || "").trim();
  const entries = ["asset", "liability", "income", "expense", "nonOperatingIncome", "nonOperatingExpense"];
  return entries.find((type) => desktopSettingsTypeLabel(type) === value || type === value) || "";
}

function resolveImportItem(name) {
  const text = String(name || "").trim();
  const account = state.accounts.find((item) => item.name === text);
  if (account) {
    return { kind: "account", id: account.id, name: account.name, type: inferAccountType(account) };
  }
  const category = state.categories.find((item) => item.name === text);
  if (category) {
    return { kind: "category", id: category.id, name: category.name, type: category.type };
  }
  return emptyTransactionItem();
}

function downloadCsv(rows, filename) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function isItemReferenced(item) {
  if (!item) {
    return false;
  }

  const transactionKind = item.collection === "accounts" ? "account" : "category";
  const usedInTransactions = state.transactions.some((transaction) => {
    return (
      (transaction.fromItem?.kind === transactionKind && transaction.fromItem?.id === item.id) ||
      (transaction.toItem?.kind === transactionKind && transaction.toItem?.id === item.id)
    );
  });

  if (usedInTransactions) {
    return true;
  }

  if (item.collection === "accounts") {
    return state.recurring.some((entry) => entry.accountId === item.id);
  }

  return state.recurring.some((entry) => entry.categoryId === item.id);
}
