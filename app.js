import { applySessionBootstrapState, initializeAppSession } from "./data/app-session.js";

let runtimeSessionObserved = false;
const COMMON_SUMMARY_STORAGE_KEY = "financeCommonSummaries:v2";

window.addEventListener("error", (event) => {
  const message = event.error?.message || event.message || "未知錯誤";
  const status = document.getElementById("sessionStatus");
  const sessionError = document.getElementById("sessionError");
  if (status) {
    status.textContent = "前端初始化失敗";
  }
  if (sessionError) {
    sessionError.textContent = `初始化錯誤：${message}`;
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || event.reason?.code || String(event.reason || "未知錯誤");
  const status = document.getElementById("sessionStatus");
  const sessionError = document.getElementById("sessionError");
  if (status) {
    status.textContent = "前端初始化失敗";
  }
  if (sessionError) {
    sessionError.textContent = `初始化錯誤：${reason}`;
  }
});

const appSession = await initializeAppSession();
const {
  runtime: appRuntime,
  dataBackend,
  bootstrapError: runtimeBootstrapError,
  bootstrapErrorMessage,
  hasConfig: hasBackendConfig,
  initialData: runtimeInitialData,
  modeNotice,
  providerLabel
} = appSession;
const waitingProviderStatus = appSession.waitingStatus;
const seededCommonSummaries =
  runtimeInitialData?.commonSummaries && typeof runtimeInitialData.commonSummaries === "object"
    ? runtimeInitialData.commonSummaries
    : {};

applySessionBootstrapState({
  hasConfig: hasBackendConfig,
  waitingStatus: waitingProviderStatus,
  bootstrapError: runtimeBootstrapError,
  bootstrapErrorMessage,
  modeNotice,
  setStatus(nextValue) {
    document.getElementById("sessionStatus").textContent = String(nextValue || "");
  },
  setError(nextValue) {
    const current = document.getElementById("sessionError").textContent;
    document.getElementById("sessionError").textContent =
      typeof nextValue === "function" ? String(nextValue(current) || "") : String(nextValue || "");
  }
});

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
    accountBaseValues: new Map(),
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
  sqliteBridgeAdmin: {
    status: null,
    loading: false,
    rebuilding: false,
    error: ""
  },
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
const BASE_CURRENCY = "TWD";
const decimalFmt = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 0
});
const fmt = (value) =>
  new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: BASE_CURRENCY,
    maximumFractionDigits: 0
  }).format(Number(value || 0));

function normalizeCurrencyCode(value) {
  return String(value || BASE_CURRENCY).trim().toUpperCase() || BASE_CURRENCY;
}

function getAccountCurrency(account) {
  return normalizeCurrencyCode(account?.currency || BASE_CURRENCY);
}

function isForeignCurrencyCode(currency) {
  return normalizeCurrencyCode(currency) !== BASE_CURRENCY;
}

function isForeignCurrencyAccount(account) {
  return inferAccountType(account) && isForeignCurrencyCode(getAccountCurrency(account));
}

function fmtAccountAmount(value, currency = BASE_CURRENCY) {
  return `${normalizeCurrencyCode(currency)} ${decimalFmt.format(Number(value || 0))}`;
}

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
  state.derivedDataCache.accountBaseValues.clear();
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

function supportsSQLiteBridgeAdmin() {
  return typeof dataBackend?.loadAdminStatus === "function" && typeof dataBackend?.rebuildSnapshots === "function";
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

if (hasBackendConfig) {
  bindEvents();

  appRuntime.observeSessionState(async (user) => {
    runtimeSessionObserved = true;
    if (!user) {
      state.uid = null;
      resetStateData();
      renderSessionState(null);
      renderAll();
      return;
    }

    state.uid = user.uid;
    renderSessionState(user);
    await bootstrap();
  });
}

window.setTimeout(() => {
  if (!runtimeSessionObserved && document.getElementById("sessionStatus")?.textContent === waitingProviderStatus) {
    document.getElementById("sessionStatus").textContent = `${providerLabel} 初始化逾時`;
    document.getElementById("sessionError").textContent = `前端沒有成功完成 ${providerLabel} 初始化，請重新整理頁面；若仍發生，請回報這一行訊息。`;
  }
}, 5000);

function resetStateData() {
  state.accounts = [];
  state.categories = [];
  state.transactions = [];
  resetSnapshotState();
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
  state.sqliteBridgeAdmin = {
    status: null,
    loading: false,
    rebuilding: false,
    error: ""
  };
  invalidateDerivedDataCache();
}

function resetSnapshotState() {
  state.monthlySnapshots = [];
  state.loadedSnapshotMonths.clear();
  state.loadedLatestSnapshotBeforeTargets.clear();
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
  await dataBackend.saveSettingsPatch({
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

async function bootstrap() {
  await ensureDefaults();
  await deleteLegacyTransactions();
  await loadAll();
  if (await normalizeAllItemOrders()) {
    await loadAll();
  }
  bindEvents();
  syncTransactionAmountFields("mobile", false);
  syncTransactionAmountFields("desktop", false);
  await applyRecurringIfNeeded();
  await refreshSQLiteBridgeAdminStatus({ silent: true });
  renderAll();
}

async function ensureDefaults() {
  const [storedSettings, initialCategories, accounts] = await Promise.all([
    dataBackend.loadStoredSettingsState(),
    dataBackend.loadCollectionItems("categories"),
    dataBackend.loadCollectionItems("accounts")
  ]);
  if (!storedSettings) {
    state.settings = {
      monthlyBudget: 0,
      recurringAppliedMonth: "",
      snapshotDirtyFromMonth: "",
      legacyTransactionsCheckedAt: 0
    };
    await dataBackend.replaceSettingsState(state.settings);
  } else {
    state.settings = {
      monthlyBudget: Number(storedSettings.monthlyBudget || 0),
      recurringAppliedMonth: String(storedSettings.recurringAppliedMonth || ""),
      snapshotDirtyFromMonth: String(storedSettings.snapshotDirtyFromMonth || ""),
      legacyTransactionsCheckedAt: Number(storedSettings.legacyTransactionsCheckedAt || 0)
    };
  }

  let categories = initialCategories;
  if (!categories.length) {
    for (const category of DEFAULT_CATEGORIES) {
      await dataBackend.createUserCollectionDocument("categories", { ...category, createdAt: Date.now() });
    }
    categories = await dataBackend.loadCollectionItems("categories");
  } else {
    await ensureDefaultCategories(categories);
    categories = await dataBackend.loadCollectionItems("categories");
  }

  await ensureProtectedItems(accounts, categories);
}

async function ensureDefaultCategories(categories) {
  await Promise.all(
    DEFAULT_CATEGORIES.map(async (category) => {
      const protectedItem = PROTECTED_ITEMS.find(
        (item) => item.collection === "categories" && item.type === category.type && item.name === category.name
      );
      const validNames = [category.name, ...(protectedItem?.aliases || [])];
      const exists = categories.some((item) => item.type === category.type && validNames.includes(String(item.name || "")));
      if (exists) {
        return;
      }
      await dataBackend.createUserCollectionDocument("categories", { ...category, createdAt: Date.now() });
    })
  );
}

async function ensureProtectedItems(accounts, categories) {
  await Promise.all(
    PROTECTED_ITEMS.map(async (protectedItem) => {
      const items = protectedItem.collection === "accounts" ? accounts : categories;
      const match = items.find((item) => {
        const type = protectedItem.collection === "accounts" ? inferAccountType(item) : item.type;
        return (
          type === protectedItem.type &&
          [protectedItem.name, ...(protectedItem.aliases || [])].includes(String(item.name || ""))
        );
      });
      const payload = {
        name: protectedItem.name,
        type: protectedItem.type,
        order: protectedItem.order
      };

      if (match) {
        const currentType = protectedItem.collection === "accounts" ? inferAccountType(match) : match.type;
        if (String(match.name || "") === payload.name && currentType === payload.type && getItemOrder(match) === payload.order) {
          return;
        }
        await dataBackend.updateUserCollectionDocument(protectedItem.collection, match.id, payload);
        return;
      }

      const defaults = protectedItem.collection === "accounts" ? { balance: 0, currency: BASE_CURRENCY } : {};
      await dataBackend.createUserCollectionDocument(protectedItem.collection, {
        ...payload,
        ...defaults,
        createdAt: Date.now()
      });
    })
  );
}

async function loadAll() {
  resetSnapshotState();
  await Promise.all([loadReferenceDataState(), loadSettingsState(), loadHistoryMetadata(), loadCommonSummaryState()]);
  await loadCurrentViewData();
}

async function loadReferenceDataState() {
  const { accounts, categories, recurring } = await dataBackend.loadReferenceData();
  state.accounts = accounts;
  state.categories = categories;
  state.recurring = recurring;
  invalidateDerivedDataCache();
}

async function loadSettingsState() {
  const settingsData = await dataBackend.loadSettingsState();
  state.settings = {
    monthlyBudget: 0,
    recurringAppliedMonth: "",
    snapshotDirtyFromMonth: "",
    legacyTransactionsCheckedAt: 0,
    ...settingsData
  };
}

async function loadHistoryMetadata() {
  const historyMetadata = await dataBackend.loadHistoryMetadata();
  state.earliestTransactionMonth = historyMetadata.earliestTransactionMonth;
  state.earliestSnapshotMonth = historyMetadata.earliestSnapshotMonth;
  state.hasTransactions = historyMetadata.hasTransactions;
}

async function loadCurrentViewData({ resetSnapshots = false } = {}) {
  if (resetSnapshots) {
    resetSnapshotState();
  }
  await refreshTransactionsForCurrentView();
}

async function refreshSQLiteBridgeAdminStatus({ silent = false } = {}) {
  if (!supportsSQLiteBridgeAdmin() || !state.uid) {
    state.sqliteBridgeAdmin.status = null;
    state.sqliteBridgeAdmin.error = "";
    state.sqliteBridgeAdmin.loading = false;
    return;
  }

  if (!silent) {
    state.sqliteBridgeAdmin.loading = true;
    renderSQLiteBridgeAdmin();
  }

  try {
    state.sqliteBridgeAdmin.status = await dataBackend.loadAdminStatus();
    state.sqliteBridgeAdmin.error = "";
  } catch (error) {
    state.sqliteBridgeAdmin.error = error?.message || String(error || "未知錯誤");
  } finally {
    state.sqliteBridgeAdmin.loading = false;
    renderSQLiteBridgeAdmin();
  }
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
  const snapshot = await dataBackend.loadSnapshotByMonth(normalizedMonth);
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
  const snapshot = await dataBackend.loadLatestSnapshotBeforeMonth(normalizedMonth);
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
  return dataBackend.loadTransactionsByDateRange(startDate, endDate);
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

  const transactions = await dataBackend.loadCollectionItems("transactions");
  const legacyDocs = transactions.filter((item) => !item.fromItem || !item.toItem);

  await Promise.all(legacyDocs.map((item) => dataBackend.deleteUserCollectionDocument("transactions", item.id)));
  const checkedAt = Date.now();
  await dataBackend.saveSettingsPatch({
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
    syncTransactionAmountFields("mobile", false);
  });

  $("destinationTypeSelect").addEventListener("change", (event) => {
    state.transactionDestinationType = event.currentTarget.value;
    localStorage.setItem("financeTransactionDestinationType", state.transactionDestinationType);
    renderDestinationItemOptions(state.transactionDestinationType);
    renderCommonSummaryOptions();
    syncTransactionAmountFields("mobile", false);
  });
  $("desktopSourceTypeSelect").addEventListener("change", () => {
    state.transactionSourceType = $("desktopSourceTypeSelect").value;
    localStorage.setItem("financeTransactionSourceType", state.transactionSourceType);
    renderDesktopSourceItemOptions();
    renderCommonSummaryOptions();
    syncTransactionAmountFields("desktop", false);
  });
  $("desktopDestinationTypeSelect").addEventListener("change", (event) => {
    state.transactionDestinationType = event.currentTarget.value;
    localStorage.setItem("financeTransactionDestinationType", state.transactionDestinationType);
    renderDesktopDestinationItemOptions(state.transactionDestinationType);
    renderCommonSummaryOptions();
    syncTransactionAmountFields("desktop", false);
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
    await dataBackend.saveSettingsPatch({
      monthlyBudget: Number(formData.get("monthlyBudget") || 0)
    });
    await loadSettingsState();
    renderAll();
  });
  $("sqliteBridgeRefreshBtn")?.addEventListener("click", () => refreshSQLiteBridgeAdminStatus());
  $("sqliteRebuildSnapshotsBtn")?.addEventListener("click", rebuildSQLiteBridgeSnapshots);

  $("emailSessionForm").addEventListener("submit", handleEmailAuth);
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
  $("desktopSourceSelect").addEventListener("change", () => syncTransactionAmountFields("desktop", false));
  $("desktopDestinationSelect").addEventListener("change", () => syncTransactionAmountFields("desktop", false));
  $("sourceSelect").addEventListener("change", () => syncTransactionAmountFields("mobile", false));
  $("destinationSelect").addEventListener("change", () => syncTransactionAmountFields("mobile", false));
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
    $("sessionError").textContent = "";
      await appRuntime.signOutSession();
  });
}

async function handleEmailAuth(event) {
  event.preventDefault();
  $("sessionError").textContent = "";
  const form = event.currentTarget;

  const formData = new FormData(form);
  const action = event.submitter?.value || "login";
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  if (action === "register" && !appRuntime.supportsCredentialRegistration) {
    $("sessionStatus").textContent = "只開放登入";
    $("sessionError").textContent = "目前這個 SQLite bridge 只開放既有帳號登入。";
    return;
  }

  try {
    $("sessionStatus").textContent = action === "register" ? "建立帳號中..." : "登入中...";

    if (action === "register") {
      await appRuntime.registerWithCredentials(email, password);
    } else {
      await appRuntime.signInWithCredentials(email, password);
    }

    form.reset();
  } catch (error) {
    $("sessionStatus").textContent = "登入失敗";
    $("sessionError").textContent = formatAuthError(action, error);
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
    "auth/user-not-found": appRuntime.supportsCredentialRegistration
      ? "找不到這個帳號，請先註冊。"
      : "找不到這個帳號，請確認 sqlite:frontend 啟動時指定的 Email。",
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

  const payload = buildTransactionPayloadFromForm(event.target);
  if (!isValidTransactionPayload(payload)) {
    showMessage("請確認日期與金額格式正確。", "資料錯誤");
    return;
  }

  if (!state.desktopMode && state.mobileEditingTransactionId) {
    await dataBackend.saveUserCollectionDocument("transactions", state.mobileEditingTransactionId, payload);
    state.mobileSelectedTransactionId = state.mobileEditingTransactionId;
    state.mobileEditingTransactionId = "";
  } else if (state.desktopMode && state.desktopEditingTransactionId) {
    await dataBackend.saveUserCollectionDocument("transactions", state.desktopEditingTransactionId, payload);
    state.desktopSelectedTransactionId = state.desktopEditingTransactionId;
  } else {
    const transactionRef = await dataBackend.createUserCollectionDocument("transactions", payload);
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
  await loadHistoryMetadata();
  await loadCurrentViewData({ resetSnapshots: true });
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
  syncTransactionAmountFields("desktop", false);
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

  await dataBackend.deleteUserCollectionDocument("transactions", transaction.id);
  await markSnapshotDirtyFromMonth(monthKey(transaction.date));
  state.mobileSelectedTransactionId = "";
  state.mobileEditingTransactionId = "";
  await loadHistoryMetadata();
  await loadCurrentViewData({ resetSnapshots: true });
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
  form.elements.amount.value = getTransactionAmount(transaction) || "";
  form.elements.fromAmount.value = getTransactionSideAmount(transaction, "from") || "";
  form.elements.toAmount.value = getTransactionSideAmount(transaction, "to") || "";
  form.elements.note.value = transaction.note || "";
  form.elements.memo.value = transaction.memo || "";
  syncTransactionAmountFields("mobile");
  document.querySelector("#ledger .card h3").textContent = "編輯記錄";
  form.querySelector('button[type="submit"]').textContent = "儲存修改";
  $("cancelMobileEditBtn").classList.remove("hidden");
  (getTransactionFormMode("mobile").usesSplitAmounts ? form.elements.fromAmount : form.elements.amount).focus();
}

function resetMobileTransactionForm() {
  state.mobileEditingTransactionId = "";
  document.body.classList.remove("mobile-editing-transaction");
  document.querySelector("#ledger .card h3").textContent = "新增記錄";
  $("cancelMobileEditBtn").classList.add("hidden");
  $("transactionForm").querySelector('button[type="submit"]').textContent = "新增記錄";
  syncTransactionAmountFields("mobile", false);
}

function renderMobileItemFields() {
  const isAccount = isDesktopAccountType($("mobileItemTypeSelect").value);
  $("mobileItemBalanceField").classList.toggle("hidden", !isAccount);
  $("mobileItemCurrencyField").classList.toggle("hidden", !isAccount);
}

function getTransactionFormMode(formKind = "mobile") {
  const sourceSelectId = formKind === "desktop" ? "desktopSourceSelect" : "sourceSelect";
  const destinationSelectId = formKind === "desktop" ? "desktopDestinationSelect" : "destinationSelect";
  const fromItem = buildTransactionItem(String($(sourceSelectId)?.value || ""));
  const toItem = buildTransactionItem(String($(destinationSelectId)?.value || ""));
  return {
    fromItem,
    toItem,
    usesSplitAmounts: usesSplitAmountInputs(fromItem, toItem)
  };
}

function syncTransactionAmountFields(formKind = "mobile", preserveValues = true) {
  const formId = formKind === "desktop" ? "desktopTransactionForm" : "transactionForm";
  const singleAmountLabelId = formKind === "desktop" ? "desktopSingleAmountLabel" : "mobileSingleAmountLabel";
  const singleAmountFieldId = formKind === "desktop" ? "desktopSingleAmountField" : "mobileSingleAmountField";
  const fromFieldId = formKind === "desktop" ? "desktopFromAmountField" : "mobileFromAmountField";
  const toFieldId = formKind === "desktop" ? "desktopToAmountField" : "mobileToAmountField";
  const form = $(formId);
  if (!form) {
    return;
  }
  const mode = getTransactionFormMode(formKind);
  const amountInput = form.elements.amount;
  const fromAmountInput = form.elements.fromAmount;
  const toAmountInput = form.elements.toAmount;
  const singleAmountLabel = $(singleAmountLabelId);
  $(singleAmountFieldId)?.classList.toggle("hidden", mode.usesSplitAmounts);
  $(fromFieldId)?.classList.toggle("hidden", !mode.usesSplitAmounts);
  $(toFieldId)?.classList.toggle("hidden", !mode.usesSplitAmounts);
  if (singleAmountLabel) {
    singleAmountLabel.textContent = mode.usesSplitAmounts ? "本位幣金額" : "金額";
  }
  amountInput.required = !mode.usesSplitAmounts;
  fromAmountInput.required = mode.usesSplitAmounts;
  toAmountInput.required = mode.usesSplitAmounts;
  if (mode.usesSplitAmounts) {
    if (!preserveValues || !Number(fromAmountInput.value || 0)) {
      fromAmountInput.value = amountInput.value || fromAmountInput.value || "";
    }
    if (!preserveValues || !Number(toAmountInput.value || 0)) {
      toAmountInput.value = amountInput.value || toAmountInput.value || "";
    }
  } else if (!preserveValues || !amountInput.value) {
    amountInput.value = toAmountInput.value || fromAmountInput.value || amountInput.value || "";
  }
}

function buildTransactionPayloadFromForm(form) {
  const formKind = form.id === "desktopTransactionForm" ? "desktop" : "mobile";
  const mode = getTransactionFormMode(formKind);
  const amount = Number(form.elements.amount.value || 0);
  const fromAmount = mode.usesSplitAmounts ? Number(form.elements.fromAmount.value || 0) : amount;
  const toAmount = mode.usesSplitAmounts ? Number(form.elements.toAmount.value || 0) : amount;
  return {
    date: String(form.elements.date.value || ""),
    fromItem: mode.fromItem,
    toItem: mode.toItem,
    amount: toAmount,
    fromAmount,
    toAmount,
    note: String(form.elements.note.value || ""),
    memo: String(form.elements.memo.value || "")
  };
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
    const currency = normalizeCurrencyCode(formData.get("currency") || BASE_CURRENCY);
    if (balance === null) {
      showMessage("請確認期初餘額為有效數字。", "資料錯誤");
      return;
    }
    const itemRef = await dataBackend.createUserCollectionDocument("accounts", {
      name,
      balance,
      currency,
      type,
      order,
      createdAt: Date.now()
    });
    await loadReferenceDataState();
    if (await normalizeItemOrders(type, itemRef.id)) {
      await loadReferenceDataState();
    }
  } else {
    const itemRef = await dataBackend.createUserCollectionDocument("categories", {
      name,
      type,
      order,
      createdAt: Date.now()
    });
    await loadReferenceDataState();
    if (await normalizeItemOrders(type, itemRef.id)) {
      await loadReferenceDataState();
    }
  }

  event.target.reset();
  renderMobileItemFields();
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

  await dataBackend.deleteUserCollectionDocument("transactions", transaction.id);
  await markSnapshotDirtyFromMonth(monthKey(transaction.date));
  state.desktopSelectedTransactionId = "";
  await loadHistoryMetadata();
  await loadCurrentViewData({ resetSnapshots: true });
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
  form.elements.amount.value = getTransactionAmount(transaction) || "";
  form.elements.fromAmount.value = getTransactionSideAmount(transaction, "from") || "";
  form.elements.toAmount.value = getTransactionSideAmount(transaction, "to") || "";
  form.elements.note.value = transaction.note || "";
  form.elements.memo.value = transaction.memo || "";
  syncTransactionAmountFields("desktop");
  (getTransactionFormMode("desktop").usesSplitAmounts ? form.elements.fromAmount : form.elements.amount).focus();
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
  $("desktopItemForm").elements.currency.value = item?.currency || BASE_CURRENCY;
  $("desktopItemForm").elements.order.value = item?.order ?? getNextItemOrder(state.desktopSettingsType);
  $("desktopItemForm").elements.name.disabled = protectedItem;
  $("desktopItemForm").elements.order.disabled = protectedItem;
  $("desktopItemBalanceField").classList.toggle("hidden", !isDesktopAccountType(state.desktopSettingsType));
  $("desktopItemCurrencyField").classList.toggle("hidden", !isDesktopAccountType(state.desktopSettingsType));
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

function renderSessionState(user) {
  if (!user) {
    document.body.classList.add("session-signed-out");
    $("appShell").classList.add("hidden");
    $("emailSessionForm").classList.toggle("hidden", !appRuntime.supportsCredentialSession);
    $("sessionControls").classList.add("hidden");
    if (!$("sessionError").textContent) {
      if (appRuntime.supportsCredentialSession) {
        $("sessionStatus").textContent = appRuntime.supportsCredentialRegistration
          ? "請輸入 Email 與密碼登入或註冊"
          : "請輸入 Email 與密碼登入";
      } else {
        $("sessionStatus").textContent = `等待 ${providerLabel} 後端就緒`;
      }
    }
    return;
  }

  document.body.classList.remove("session-signed-out");
  $("sessionStatus").textContent = appRuntime.supportsCredentialSession ? getDisplayName(user) : `${providerLabel} 已連線`;
  $("appShell").classList.remove("hidden");
  $("emailSessionForm").classList.add("hidden");
  $("sessionControls").classList.remove("hidden");
  $("desktopViewBtn").textContent = state.desktopMode ? "手機版" : "桌面版";
  $("signOutBtn").classList.toggle("hidden", !appRuntime.supportsSessionSignOut);
}

function renderCredentialFormOptions() {
  const registerButton = $("sessionRegisterBtn");
  if (!registerButton) {
    return;
  }
  registerButton.classList.toggle("hidden", !appRuntime.supportsCredentialRegistration);
}

function getDisplayName(user) {
  if (user.displayName) {
    return user.displayName;
  }
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
    await dataBackend.createUserCollectionDocument("transactions", {
      date,
      fromItem: accountItem(item.accountId),
      toItem: categoryItem(item.categoryId),
      amount: item.amount,
      note: `固定支出：${item.name}`,
    });
  }

  await dataBackend.saveSettingsPatch({
    recurringAppliedMonth: currentMonth,
    snapshotDirtyFromMonth: earlierMonth(state.settings.snapshotDirtyFromMonth, currentMonth) || currentMonth
  });
  state.settings.snapshotDirtyFromMonth = earlierMonth(state.settings.snapshotDirtyFromMonth, currentMonth) || currentMonth;
  await loadHistoryMetadata();
  await loadCurrentViewData({ resetSnapshots: true });
}

function renderAll() {
  renderCredentialFormOptions();
  renderDesktopMode();
  renderOptions();
  renderMobileItemFields();
  syncTransactionAmountFields("mobile");
  syncTransactionAmountFields("desktop");
  renderOverview();
  renderTransactionRangeFilter();
  renderTransactions();
  renderCharts();
  renderDesktopSidebar();
  renderDesktopSettings();
  renderSQLiteBridgeAdmin();
}

function renderSQLiteBridgeAdmin() {
  const card = $("sqliteBridgeAdminCard");
  if (!card) {
    return;
  }

  const supported = supportsSQLiteBridgeAdmin() && Boolean(state.uid);
  card.classList.toggle("hidden", !supported);
  if (!supported) {
    return;
  }

  const statusNode = $("sqliteBridgeAdminStatus");
  const countsNode = $("sqliteBridgeAdminCounts");
  const refreshButton = $("sqliteBridgeRefreshBtn");
  const rebuildButton = $("sqliteRebuildSnapshotsBtn");
  const { status, loading, rebuilding, error } = state.sqliteBridgeAdmin;
  const transactionCount = state.hasTransactions ? state.transactions.length : 0;
  const snapshotCount = state.monthlySnapshots.length;
  const commonSummaryCount = Object.values(state.commonSummaries || {}).reduce(
    (sum, summaries) => sum + (Array.isArray(summaries) ? summaries.length : 0),
    0
  );
  const accountCount = state.accounts.length;
  const categoryCount = state.categories.length;

  if (refreshButton) {
    refreshButton.disabled = loading || rebuilding;
    refreshButton.textContent = loading ? "更新中..." : "重新整理狀態";
  }
  if (rebuildButton) {
    rebuildButton.disabled = loading || rebuilding;
    rebuildButton.textContent = rebuilding ? "重建中..." : "重建 snapshot";
  }

  if (error) {
    statusNode.textContent = `bridge 狀態讀取失敗：${error}`;
    countsNode.textContent = "";
    return;
  }

  if (!status) {
    statusNode.textContent = loading ? "讀取 bridge 狀態中..." : "尚未讀取 bridge 狀態";
    countsNode.textContent = "";
    return;
  }

  const dirtyFromMonth = String(status.settings?.snapshotDirtyFromMonth || "").trim() || "無";
  const earliestTransactionMonth = String(state.earliestTransactionMonth || status.history?.earliestTransactionMonth || "").trim() || "無";
  statusNode.textContent = [
    `DB：${status.dbPath || ""}`,
    `使用者：${status.userId || state.uid}`,
    `待重建起始月：${dirtyFromMonth}`,
    `最早交易月：${earliestTransactionMonth}`
  ].join(" | ");
  countsNode.textContent = [
    `accounts ${accountCount || Number(status.counts?.accounts || 0)}`,
    `categories ${categoryCount || Number(status.counts?.categories || 0)}`,
    `transactions ${transactionCount || Number(status.counts?.transactions || 0)}`,
    `snapshots ${snapshotCount || Number(status.counts?.monthlySnapshots || 0)}`,
    `common summaries ${commonSummaryCount || Number(status.counts?.commonSummaries || 0)}`
  ].join(" | ");
}

async function rebuildSQLiteBridgeSnapshots() {
  if (!supportsSQLiteBridgeAdmin() || !state.uid) {
    return;
  }

  const suggestedMonth = String(state.settings.snapshotDirtyFromMonth || state.earliestTransactionMonth || "").trim();
  const input = window.prompt("輸入要重建的起始月份，格式為 YYYY-MM。留白代表全部重建。", suggestedMonth);
  if (input === null) {
    return;
  }
  const fromMonth = String(input || "").trim();
  if (fromMonth && !/^\d{4}-\d{2}$/.test(fromMonth)) {
    showMessage("月份格式必須是 YYYY-MM。", "重建失敗");
    return;
  }
  if (!window.confirm(`確定要${fromMonth ? `從 ${fromMonth}` : "全部"}重建 monthly snapshots 嗎？`)) {
    return;
  }

  state.sqliteBridgeAdmin.rebuilding = true;
  state.sqliteBridgeAdmin.error = "";
  renderSQLiteBridgeAdmin();

  try {
    const result = await dataBackend.rebuildSnapshots({
      fromMonth
    });
    await Promise.all([
      loadSettingsState(),
      loadHistoryMetadata(),
      loadCurrentViewData({ resetSnapshots: true }),
      refreshSQLiteBridgeAdminStatus({ silent: true })
    ]);
    renderAll();
    showMessage(
      `已重建 ${Number(result.snapshotCount || 0)} 個月份快照，涵蓋到 ${String(result.toMonth || "無")}。`,
      "Snapshot 重建完成"
    );
  } catch (error) {
    const message = error?.message || String(error || "未知錯誤");
    state.sqliteBridgeAdmin.error = message;
    renderSQLiteBridgeAdmin();
    showMessage(`重建失敗：${message}`, "Snapshot 重建失敗");
  } finally {
    state.sqliteBridgeAdmin.rebuilding = false;
    renderSQLiteBridgeAdmin();
  }
}

function getDesktopSidebarStructureRenderKey(groups) {
  return groups
    .map((group) => `${group.key}:${group.items.map((item) => item.key).join(",")}`)
    .join("|");
}

async function toggleDesktopMode() {
  state.desktopMode = !state.desktopMode;
  localStorage.setItem("financeDesktopMode", String(state.desktopMode));
  if (state.uid && !appRuntime.supportsCredentialSession) {
    $("desktopViewBtn").textContent = state.desktopMode ? "手機版" : "桌面版";
  }
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
  const baseValues = buildAccountBaseValues(state.desktopDate);
  const monthSnapshot = getMonthlySnapshot(state.desktopDate);
  const groups = buildDesktopSidebarGroups(balances, baseValues, monthSnapshot);
  const assetTotal = getAccountBalanceTotal("asset", balances, monthSnapshot, baseValues);
  const liabilityTotal = getAccountBalanceTotal("liability", balances, monthSnapshot, baseValues);
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
                    ${item.baseValueText ? `<small data-desktop-item-base-value="${escapeAttr(item.key)}">${item.baseValueText}</small>` : ""}
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
      const baseValueNode = document.querySelector(`[data-desktop-item-base-value="${selectorKey}"]`);
      if (baseValueNode && baseValueNode.textContent !== (item.baseValueText || "")) {
        baseValueNode.textContent = item.baseValueText || "";
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
          const amount = isDesktopAccountType(state.desktopSettingsType)
            ? `: ${fmtAccountAmount(item.balance || 0, item.currency || BASE_CURRENCY)}`
            : "";
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
  $("desktopItemEditBtn").disabled = !hasSelection;
  $("desktopItemDeleteBtn").disabled = !hasSelection;
  $("desktopItemMoveUpBtn").disabled = !selectedItem || selectedItem.protected || selectedIndex <= 0;
  $("desktopItemMoveDownBtn").disabled =
    !selectedItem || selectedItem.protected || selectedIndex < 0 || selectedIndex >= movableItems.length - 1;
  $("desktopEditSummariesBtn").disabled = !selectedItem || isDesktopAccountType(selectedItem.type);
}

function getDesktopSettingsListRenderKey(items) {
  return `${state.desktopSettingsType}:${items
    .map(
      (item) =>
        `${item.key}:${item.name}:${item.order}:${Number(item.balance || 0)}:${item.currency || ""}:${item.protected ? "1" : "0"}`
    )
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
        currency: getAccountCurrency(account),
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
  await dataBackend.batchUpdateUserCollectionOrders(updates);
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
    const currency = normalizeCurrencyCode(formData.get("currency") || BASE_CURRENCY);
    if (balance === null) {
      showMessage("請確認期初餘額為有效數字。", "資料錯誤");
      return;
    }
    const payload = {
      name,
      balance,
      currency,
      type,
      order
    };
    if (editing) {
      const previousBalance = Number(editing.balance || 0);
      await dataBackend.updateUserCollectionDocument("accounts", editing.id, payload);
      if (previousBalance !== payload.balance) {
        await markSnapshotDirtyFromMonth(getEarliestAccountTransactionMonth(editing.id) || getEarliestTransactionMonth());
      }
      await loadReferenceDataState();
      if (await normalizeItemOrders(type, editing.id)) {
        await loadReferenceDataState();
      }
    } else {
      const itemRef = await dataBackend.createUserCollectionDocument("accounts", { ...payload, createdAt: Date.now() });
      await loadReferenceDataState();
      if (await normalizeItemOrders(type, itemRef.id)) {
        await loadReferenceDataState();
      }
    }
  } else {
    const payload = {
      name,
      type,
      order
    };
    if (editing) {
      await dataBackend.updateUserCollectionDocument("categories", editing.id, payload);
      await loadReferenceDataState();
      if (await normalizeItemOrders(type, editing.id)) {
        await loadReferenceDataState();
      }
    } else {
      const itemRef = await dataBackend.createUserCollectionDocument("categories", { ...payload, createdAt: Date.now() });
      await loadReferenceDataState();
      if (await normalizeItemOrders(type, itemRef.id)) {
        await loadReferenceDataState();
      }
    }
  }

  closeDesktopItemModal();
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

  await dataBackend.deleteUserCollectionDocument(item.collection, item.id);
  state.desktopSettingsSelectedId = "";
  await loadReferenceDataState();
  renderAll();
}

async function moveDesktopSettingsItem(direction) {
  if (await normalizeItemOrders(state.desktopSettingsType)) {
    await loadReferenceDataState();
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

  await dataBackend.batchUpdateUserCollectionOrders(
    reorderedItems.map((item, index) => ({
      collection: item.collection,
      id: item.id,
      order: (index + 1) * 10
    }))
  );

  state.desktopSettingsSelectedId = current.key;
  await loadReferenceDataState();
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
    options.push({ value: String(year), label: String(year) });
  }
  replaceSelectOptions(select, options);
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

function getSnapshotAccountBaseValue(snapshot, accountId, fallbackValue = 0) {
  return Number(snapshot?.closingBaseValues?.[accountId] ?? fallbackValue ?? 0);
}

function buildDesktopSidebarGroups(balances, baseValues, monthSnapshot = null) {
  const monthTransactions = getDesktopLoadedMonthTransactions();

  const assetItems = buildDesktopAccountItems("asset", balances, baseValues, monthSnapshot);
  const liabilityItems = buildDesktopAccountItems("liability", balances, baseValues, monthSnapshot);

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
      totalText: fmt(getAccountBalanceTotal("asset", balances, monthSnapshot, baseValues))
    },
    {
      key: "liability",
      label: "負債",
      badge: "L",
      items: liabilityItems,
      totalText: fmt(getAccountBalanceTotal("liability", balances, monthSnapshot, baseValues))
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

function buildDesktopAccountItems(type, balances, baseValues, monthSnapshot = null) {
  return state.accounts
    .filter((account) => inferAccountType(account) === type)
    .sort(sortItemsByOrder)
    .map((account) => ({
      key: `account:${account.id}`,
      name: account.name,
      icon: accountIcon(account, type),
      valueText: fmtAccountAmount(
        balances[account.id] ?? account.balance ?? 0,
        getAccountCurrency(account)
      ),
      baseValueText: isForeignCurrencyAccount(account)
        ? fmt(monthSnapshot ? getSnapshotAccountBaseValue(monthSnapshot, account.id, baseValues[account.id] ?? 0) : baseValues[account.id] ?? 0)
        : ""
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
      const amount = monthTransactions.reduce((sum, transaction) => {
        const contribution = getTransactionCategoryContribution(transaction, type).find((entry) => entry.item.id === category.id);
        return sum + Number(contribution?.delta || 0);
      }, 0);

      return {
        key: `category:${category.id}`,
        name: category.name,
        icon: categoryIcon(category),
        valueText: fmt(amount)
      };
    });
}

function getAccountBalanceTotal(type, balances, monthSnapshot = null, baseValues = null) {
  return state.accounts
    .filter((account) => inferAccountType(account) === type)
    .reduce(
      (sum, account) =>
        sum +
        Number(
          monthSnapshot
            ? getSnapshotAccountBaseValue(monthSnapshot, account.id, baseValues?.[account.id] ?? balances[account.id] ?? account.balance ?? 0)
            : baseValues?.[account.id] ?? balances[account.id] ?? account.balance ?? 0
        ),
      0
    );
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

function buildOptionNode(value, label) {
  const option = document.createElement("option");
  option.value = String(value ?? "");
  option.textContent = String(label ?? "");
  return option;
}

function replaceSelectOptions(select, options, { emptyLabel = "" } = {}) {
  const fragment = document.createDocumentFragment();
  if (options.length) {
    options.forEach((option) => {
      fragment.appendChild(buildOptionNode(option.value, option.label));
    });
  } else if (emptyLabel) {
    fragment.appendChild(buildOptionNode("", emptyLabel));
  }
  select.replaceChildren(fragment);
}

function renderCommonSummaryOptions() {
  const datalist = $("commonSummaryList");
  datalist.replaceChildren(
    ...getCommonSummaries(getActiveSummaryScopeKey()).map((summary) => {
      const option = document.createElement("option");
      option.value = String(summary || "");
      return option;
    })
  );
  renderSummaryMenu("desktopSummaryInput", "desktopSummaryMenu", "desktop");
  renderSummaryMenu("mobileSummaryInput", "mobileSummaryMenu", "mobile");
  updateSaveSummaryButtons();
}

function loadCommonSummaryStore() {
  if (typeof dataBackend?.loadCommonSummariesState === "function") {
    return cloneCommonSummaryStore(seededCommonSummaries);
  }
  const raw = readJsonStorage(COMMON_SUMMARY_STORAGE_KEY, {});
  if (Array.isArray(raw)) {
    return { global: raw };
  }
  if (raw && typeof raw === "object" && Object.keys(raw).length) {
    return raw;
  }
  return cloneCommonSummaryStore(seededCommonSummaries);
}

function cloneCommonSummaryStore(store) {
  return store && typeof store === "object" ? JSON.parse(JSON.stringify(store)) : {};
}

async function loadCommonSummaryState() {
  if (typeof dataBackend?.loadCommonSummariesState !== "function") {
    state.commonSummaries = loadCommonSummaryStore();
    return;
  }
  state.commonSummaries = cloneCommonSummaryStore(await dataBackend.loadCommonSummariesState());
}

function getCommonSummaries(scopeKey) {
  const scoped = state.commonSummaries[scopeKey] || [];
  const fallback = scopeKey === "global" ? [] : state.commonSummaries.global || [];
  return (scoped.length ? scoped : fallback).filter(Boolean).slice(0, 6);
}

async function saveCommonSummaries(scopeKey, summaries) {
  state.commonSummaries[scopeKey] = [...new Set(summaries.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 6);
  if (typeof dataBackend?.replaceCommonSummariesState === "function") {
    await dataBackend.replaceCommonSummariesState(state.commonSummaries);
  } else {
    localStorage.setItem(COMMON_SUMMARY_STORAGE_KEY, JSON.stringify(state.commonSummaries));
  }
  renderCommonSummaryOptions();
}

async function saveSummaryFromInput(inputId, formKind) {
  const value = $(inputId).value.trim();
  const scopeKey = getSummaryScopeKey(formKind);
  if (!value || !scopeKey) {
    return;
  }
  const itemName = getSummaryScopeLabel(scopeKey);
  if (!window.confirm(`確定將「${value}」存為「${itemName}」的常用摘要嗎？`)) {
    return;
  }
  await saveCommonSummaries(scopeKey, [value, ...getCommonSummaries(scopeKey).filter((summary) => summary !== value)]);
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
  const fragment = document.createDocumentFragment();
  getCommonSummaries(scopeKey).forEach((summary) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.summary = String(summary || "");
    button.textContent = String(summary || "");
    fragment.appendChild(button);
  });
  menu.replaceChildren(fragment);
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
  const fragment = document.createDocumentFragment();
  Array.from({ length: 6 }, (_, index) => {
    const label = document.createElement("label");
    label.append(`${scopeLabel} 常用摘要 ${index + 1}`);
    const input = document.createElement("input");
    input.name = "summary";
    input.value = String(summaries[index] || "");
    label.appendChild(input);
    fragment.appendChild(label);
  });
  $("commonSummaryFields").replaceChildren(fragment);
}

function saveCommonSummaryForm(event) {
  event.preventDefault();
  Promise.resolve(
    saveCommonSummaries(
      state.commonSummaryEditingScopeKey || getActiveSummaryScopeKey(),
      Array.from(new FormData(event.target).getAll("summary"))
    )
  ).then(() => {
    closeCommonSummaryModal();
  });
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
  replaceSelectOptions(
    select,
    options.map((option) => ({ value: option.value, label: option.label }))
  );

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
          .map((category) => ({ value: `category:${category.id}`, label: category.name }))
      : state.accounts
          .filter((account) => inferAccountType(account) === accountType)
          .sort(sortItemsByOrder)
          .map((account) => ({ value: `account:${account.id}`, label: account.name }));

  replaceSelectOptions(sourceSelect, options, { emptyLabel: "沒有可選項目" });
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
          .map((category) => ({ value: `category:${category.id}`, label: category.name }))
      : state.accounts
          .filter((account) => inferAccountType(account) === destinationType)
          .sort(sortItemsByOrder)
          .map((account) => ({ value: `account:${account.id}`, label: account.name }));

  replaceSelectOptions(destinationSelect, options, { emptyLabel: "沒有可選項目" });
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
    type: resolved.type || "",
    currency: resolved.currency || BASE_CURRENCY
  };
}

function getTransactionSideAmount(transaction, side) {
  const key = side === "from" ? "fromAmount" : "toAmount";
  const fallback = Number(transaction?.amount || 0);
  const parsed = Number(transaction?.[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getTransactionAmount(transaction) {
  return getTransactionSideAmount(transaction, "to");
}

function usesSplitAmountInputs(fromItem, toItem) {
  return [fromItem, toItem].some((item) => item?.kind === "account" && isForeignCurrencyCode(item.currency));
}

function getTransactionDisplayAmountText(transaction, side = "to") {
  const item = side === "from" ? getTransactionFromItem(transaction) : getTransactionToItem(transaction);
  const amount = getTransactionSideAmount(transaction, side);
  return item.kind === "account" ? fmtAccountAmount(amount, item.currency) : fmt(amount);
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

function signedItemDelta(item, side, amount) {
  const itemType = String(item?.type || "");
  if (itemType === "asset" || itemType === "expense" || itemType === "nonOperatingExpense") {
    return side === "from" ? -amount : amount;
  }
  if (itemType === "liability" || itemType === "income" || itemType === "nonOperatingIncome") {
    return side === "from" ? amount : -amount;
  }
  return 0;
}

function getTransactionCategoryContribution(transaction, categoryType = "") {
  const contributions = [];
  [["from", getTransactionFromItem(transaction)], ["to", getTransactionToItem(transaction)]].forEach(([side, item]) => {
    if (item.kind !== "category" || !item.id) {
      return;
    }
    if (categoryType && item.type !== categoryType) {
      return;
    }
    const delta = signedItemDelta(item, side, getTransactionSideAmount(transaction, side));
    if (!delta) {
      return;
    }
    contributions.push({ side, item, delta });
  });
  return contributions;
}

function getTransactionAccountContribution(transaction, accountId = "") {
  let delta = 0;
  [["from", getTransactionFromItem(transaction)], ["to", getTransactionToItem(transaction)]].forEach(([side, item]) => {
    if (item.kind !== "account" || !item.id) {
      return;
    }
    if (accountId && item.id !== accountId) {
      return;
    }
    delta += signedItemDelta(item, side, getTransactionSideAmount(transaction, side));
  });
  return delta;
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
      type: account ? inferAccountType(account) : item.type || "",
      currency: account ? getAccountCurrency(account) : normalizeCurrencyCode(item.currency || BASE_CURRENCY)
    };
  }

  if (item.kind === "category") {
    const category = state.categories.find((categoryItem) => categoryItem.id === item.id);
    return {
      kind: "category",
      id: item.id,
      name: category?.name || item.name || "",
      type: category?.type || item.type || "",
      currency: BASE_CURRENCY
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
  return (
    isValidDateKey(transaction.date) &&
    Number.isFinite(getTransactionSideAmount(transaction, "from")) &&
    getTransactionSideAmount(transaction, "from") > 0 &&
    Number.isFinite(getTransactionSideAmount(transaction, "to")) &&
    getTransactionSideAmount(transaction, "to") > 0
  );
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

    state.accounts.forEach((account) => {
      balances[account.id] = (balances[account.id] || 0) + getTransactionAccountContribution(transaction, account.id);
    });
  }

  state.derivedDataCache.accountBalances.set(cacheKey, balances);
  return balances;
}

function buildAccountBaseValues(maxMonth = "") {
  const cacheKey = `${state.derivedDataRevision}:${maxMonth || "*"}`;
  const cached = state.derivedDataCache.accountBaseValues.get(cacheKey);
  if (cached) {
    return cached;
  }

  const snapshot = maxMonth ? getMonthlySnapshot(maxMonth) : getLatestUsableSnapshotBefore("9999-99");
  const snapshotMonth = snapshot?.month || "";
  const baseValues = Object.fromEntries(
    state.accounts.map((account) => [account.id, isForeignCurrencyAccount(account) ? 0 : Number(account.balance || 0)])
  );

  if (snapshot?.closingBaseValues) {
    state.accounts.forEach((account) => {
      baseValues[account.id] = Number(snapshot.closingBaseValues?.[account.id] ?? baseValues[account.id] ?? 0);
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

    state.accounts.forEach((account) => {
      baseValues[account.id] = (baseValues[account.id] || 0) + getAccountBaseDelta(transaction, account.id);
    });
  }

  state.derivedDataCache.accountBaseValues.set(cacheKey, baseValues);
  return baseValues;
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
  const baseValues = currentSnapshot ? null : buildAccountBaseValues();
  const netWorth = currentSnapshot
    ? Number(currentSnapshot.netWorth || 0)
    : state.accounts.reduce((sum, account) => {
        const value = Number((baseValues || {})[account.id] ?? (balances || {})[account.id] || 0);
        return sum + (inferAccountType(account) === "liability" ? -value : value);
      }, 0);
  $("netWorth").textContent = fmt(netWorth);

  const monthIncome = currentSnapshot
    ? getSnapshotMonthIncome(currentMonth)
    : state.transactions
        .filter((transaction) => monthKey(transaction.date) === currentMonth)
        .reduce(
          (sum, transaction) =>
            sum + getTransactionCategoryContribution(transaction, "income").reduce((subtotal, entry) => subtotal + entry.delta, 0),
          0
        );
  const monthExpense = currentSnapshot
    ? getSnapshotMonthExpense(currentMonth)
    : state.transactions
        .filter((transaction) => monthKey(transaction.date) === currentMonth)
        .reduce(
          (sum, transaction) =>
            sum + getTransactionCategoryContribution(transaction, "expense").reduce((subtotal, entry) => subtotal + entry.delta, 0),
          0
        );

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
      <th>從金額</th>
      <th>類型</th>
      <th>至項目</th>
      <th>至金額</th>
      <th>摘要</th>
      ${showBalance ? "<th>餘額</th>" : ""}
    `
    : `
      <th>日期(星期)</th>
      <th>從項目</th>
      <th>從金額</th>
      <th>類型</th>
      <th>至項目</th>
      <th>至金額</th>
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
          <td>${escapeHtml(getTransactionDisplayAmountText(transaction, "from"))}</td>
          <td>${transactionTypeText(transaction)}</td>
          <td>${escapeHtml(itemText(getTransactionToItem(transaction)))}</td>
          <td>${escapeHtml(getTransactionDisplayAmountText(transaction, "to"))}</td>
          <td>${escapeHtml(transaction.note || "-")}</td>
        </tr>`;
      })
      .join("") ||
    '<tr><td colspan="7">目前還沒有記錄資料。</td></tr>'
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
          <td>${escapeHtml(itemText(getTransactionFromItem(transaction)))}</td>
          <td><input name="fromAmount" type="number" min="1" step="1" value="${escapeAttr(getTransactionSideAmount(transaction, "from"))}" /></td>
          <td>${transactionTypeText(transaction)}</td>
          <td>${escapeHtml(itemText(getTransactionToItem(transaction)))}</td>
          <td><input name="toAmount" type="number" min="1" step="1" value="${escapeAttr(getTransactionSideAmount(transaction, "to"))}" /></td>
          <td><input name="note" list="commonSummaryList" value="${escapeAttr(transaction.note || "")}" /></td>
        </tr>`;
      })
      .join("") ||
    '<tr><td colspan="7">目前還沒有記錄資料。</td></tr>'
  );
}

function renderDesktopEditableTransactions(transactions) {
  const balanceMap = buildDesktopBalanceMap();
  const showBalance = shouldShowDesktopBalanceColumn();
  const emptyColspan = showBalance ? 8 : 7;

  return (
    transactions
      .map((transaction) => {
        const fromItem = getTransactionFromItem(transaction);
        const toItem = getTransactionToItem(transaction);
        return `<tr data-transaction-id="${escapeAttr(transaction.id)}" class="editable-row desktop-editable-row">
          <td><input name="date" type="date" value="${escapeAttr(transaction.date)}" /></td>
          <td>${renderDesktopItemEditor("from", fromItem)}</td>
          <td><input name="fromAmount" type="number" min="1" step="1" value="${escapeAttr(getTransactionSideAmount(transaction, "from"))}" /></td>
          <td class="desktop-type-preview">${transactionTypeText(transaction)}</td>
          <td>${renderDesktopItemEditor("to", toItem)}</td>
          <td><input name="toAmount" type="number" min="1" step="1" value="${escapeAttr(getTransactionSideAmount(transaction, "to"))}" /></td>
          <td><input name="note" list="commonSummaryList" value="${escapeAttr(transaction.note || "")}" /></td>
          ${showBalance ? `<td>${escapeHtml(formatDesktopBalanceValue(getDesktopBalanceScope(), balanceMap[transaction.id] ?? 0))}</td>` : ""}
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
  const emptyColspan = showBalance ? 8 : 7;

  return (
    transactions
      .map((transaction) => {
        return `<tr class="desktop-transaction-row" data-transaction-id="${escapeAttr(transaction.id)}" tabindex="0">
          <td>${escapeHtml(formatDesktopDateCell(transaction.date))}</td>
          <td>${escapeHtml(itemText(getTransactionFromItem(transaction)))}</td>
          <td>${escapeHtml(getTransactionDisplayAmountText(transaction, "from"))}</td>
          <td>${transactionTypeText(transaction)}</td>
          <td>${escapeHtml(itemText(getTransactionToItem(transaction)))}</td>
          <td>${escapeHtml(getTransactionDisplayAmountText(transaction, "to"))}</td>
          <td>${escapeHtml(transaction.note || "-")}</td>
          ${showBalance ? `<td>${escapeHtml(formatDesktopBalanceValue(getDesktopBalanceScope(), balanceMap[transaction.id] ?? 0))}</td>` : ""}
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
  replaceSelectOptions(
    itemSelect,
    getTransactionItemsByType(type).map((item) => ({
      value: `${item.kind}:${item.id}`,
      label: item.name
    })),
    { emptyLabel: "沒有可選項目" }
  );
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
  const baseValues = buildAccountBaseValues(targetMonth);
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
      .reduce((sum, account) => sum + Number(baseValues[account.id] ?? account.balance || 0), 0);
    const liabilityTotal = state.accounts
      .filter((account) => inferAccountType(account) === "liability")
      .reduce((sum, account) => sum + Number(baseValues[account.id] ?? account.balance || 0), 0);
    return assetTotal - liabilityTotal;
  }

  if (snapshot?.closingBaseValues) {
    return state.accounts
      .filter((account) => inferAccountType(account) === scope.type)
      .reduce((sum, account) => sum + Number(snapshot.closingBaseValues?.[account.id] || 0), 0);
  }

  return state.accounts
    .filter((account) => inferAccountType(account) === scope.type)
    .reduce((sum, account) => sum + Number(baseValues[account.id] ?? account.balance || 0), 0);
}

function getDesktopBalanceDelta(transaction, scope) {
  if (scope.mode === "account") {
    return getAccountDelta(transaction, scope.id);
  }

  if (scope.mode === "net-worth") {
    const assetDelta = state.accounts
      .filter((account) => inferAccountType(account) === "asset")
      .reduce((sum, account) => sum + getAccountBaseDelta(transaction, account.id), 0);
    const liabilityDelta = state.accounts
      .filter((account) => inferAccountType(account) === "liability")
      .reduce((sum, account) => sum + getAccountBaseDelta(transaction, account.id), 0);
    return assetDelta - liabilityDelta;
  }

  return state.accounts
    .filter((account) => inferAccountType(account) === scope.type)
    .reduce((sum, account) => sum + getAccountBaseDelta(transaction, account.id), 0);
}

function getAccountDelta(transaction, accountId) {
  return getTransactionAccountContribution(transaction, accountId);
}

function formatDesktopBalanceValue(scope, value) {
  if (scope?.mode === "account") {
    const account = state.accounts.find((item) => item.id === scope.id);
    return fmtAccountAmount(value, getAccountCurrency(account));
  }
  return fmt(value);
}

function getAccountBaseDelta(transaction, accountId) {
  const fromItem = getTransactionFromItem(transaction);
  const toItem = getTransactionToItem(transaction);
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) {
    return 0;
  }
  const currency = getAccountCurrency(account);
  if (!isForeignCurrencyCode(currency)) {
    return getAccountDelta(transaction, accountId);
  }

  if (fromItem.kind === "account" && fromItem.id === accountId) {
    return -Number(getTransactionSideAmount(transaction, "to") || 0);
  }
  if (toItem.kind === "account" && toItem.id === accountId) {
    return Number(getTransactionSideAmount(transaction, "from") || 0);
  }
  return 0;
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
          amount: Number(row.querySelector('[name="toAmount"]').value || 0),
          fromAmount: Number(row.querySelector('[name="fromAmount"]').value || 0),
          toAmount: Number(row.querySelector('[name="toAmount"]').value || 0),
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

    await dataBackend.saveUserCollectionDocument("transactions", row.dataset.transactionId, payload);
    dirtyMonth = earlierMonth(dirtyMonth, earlierMonth(monthKey(transaction.date), monthKey(payload.date)));
  }

  await markSnapshotDirtyFromMonth(dirtyMonth);
  state.transactionEditMode = false;
  await loadHistoryMetadata();
  await loadCurrentViewData({ resetSnapshots: true });
  renderAll();
}

function buildTransactionFromEditableRow(row) {
  return {
    date: row.querySelector('[name="date"]').value,
    fromItem: buildTransactionItem(row.querySelector('[name="fromId"]').value),
    toItem: buildTransactionItem(row.querySelector('[name="toId"]').value),
    amount: Number(row.querySelector('[name="toAmount"]').value || 0),
    fromAmount: Number(row.querySelector('[name="fromAmount"]').value || 0),
    toAmount: Number(row.querySelector('[name="toAmount"]').value || 0),
    note: row.querySelector('[name="note"]').value
  };
}

function compactTransactionItem(item) {
  return {
    kind: item?.kind || "",
    id: item?.id || "",
    name: item?.name || "",
    type: item?.type || "",
    currency: item?.currency || BASE_CURRENCY
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
    const monthTransactions = state.transactions.filter((transaction) => monthKey(transaction.date) === currentMonth);

    monthTransactions.forEach((transaction) => {
      getTransactionCategoryContribution(transaction, "expense").forEach((entry) => {
        const categoryName = itemText(entry.item) || "未分類";
        byCategory[categoryName] = (byCategory[categoryName] || 0) + entry.delta;
      });
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
          .filter((transaction) => monthKey(transaction.date) === month)
          .reduce(
            (sum, transaction) =>
              sum + getTransactionCategoryContribution(transaction, "income").reduce((subtotal, entry) => subtotal + entry.delta, 0),
            0
          )
  );

  const expenseSeries = months.map((month) =>
    getMonthlySnapshot(month)
      ? getSnapshotMonthExpense(month)
      : state.transactions
          .filter((transaction) => monthKey(transaction.date) === month)
          .reduce(
            (sum, transaction) =>
              sum + getTransactionCategoryContribution(transaction, "expense").reduce((subtotal, entry) => subtotal + entry.delta, 0),
            0
          )
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
