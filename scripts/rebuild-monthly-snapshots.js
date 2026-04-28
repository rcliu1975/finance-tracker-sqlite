#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const FIREBASE_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

function printUsage() {
  console.log(`用法：
  npm run rebuild:monthly-snapshots -- (--uid <uid> | --email <email>) [--emulator | --production] [--from <YYYY-MM>] [--apply]

參數：
  --uid <uid>             直接指定目標 Firebase Auth uid
  --email <email>         以 email 查出目標 uid
  --emulator              連到 Firebase Emulator
  --production            連到正式 Firestore
  --from <YYYY-MM>        指定從哪個月份開始重建；未指定時優先讀 snapshotDirtyFromMonth
  --apply                 實際寫入 monthlySnapshots 與清掉 dirty flag；未指定時只做 dry-run
  --env-file <path>       指定 .env，預設為專案根目錄 .env
  --host <host>           覆寫 Emulator host
  --auth-port <port>      覆寫 Auth Emulator port
  --firestore-port <port> 覆寫 Firestore Emulator port
  --project <id>          覆寫 Firebase project id
  --help                  顯示說明

範例：
  npm run rebuild:monthly-snapshots -- --uid abc123 --emulator
  npm run rebuild:monthly-snapshots -- --email you@example.com --production --from 2024-01 --apply`);
}

function parseArgs(argv) {
  const options = {
    uid: "",
    email: "",
    useEmulator: null,
    fromMonth: "",
    apply: false,
    envFile: path.join(process.cwd(), ".env"),
    host: "",
    authPort: 0,
    firestorePort: 0,
    projectId: ""
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--uid" && argv[index + 1]) {
      options.uid = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (arg === "--email" && argv[index + 1]) {
      options.email = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (arg === "--emulator") {
      options.useEmulator = true;
      continue;
    }
    if (arg === "--production") {
      options.useEmulator = false;
      continue;
    }
    if (arg === "--from" && argv[index + 1]) {
      options.fromMonth = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--env-file" && argv[index + 1]) {
      options.envFile = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--host" && argv[index + 1]) {
      options.host = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (arg === "--auth-port" && argv[index + 1]) {
      options.authPort = Number.parseInt(argv[index + 1], 10) || 0;
      index += 1;
      continue;
    }
    if (arg === "--firestore-port" && argv[index + 1]) {
      options.firestorePort = Number.parseInt(argv[index + 1], 10) || 0;
      index += 1;
      continue;
    }
    if (arg === "--project" && argv[index + 1]) {
      options.projectId = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
  }

  return options;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const values = {};
  const input = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  input.split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (!text || text.startsWith("#")) {
      return;
    }
    const separatorIndex = text.indexOf("=");
    if (separatorIndex < 0) {
      return;
    }
    const key = text.slice(0, separatorIndex).trim();
    const rawValue = text.slice(separatorIndex + 1).trim();
    values[key] = rawValue.replace(/^['"]|['"]$/g, "");
  });
  return values;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getDefaultProjectId() {
  const firebasercPath = path.join(process.cwd(), ".firebaserc");
  if (!fs.existsSync(firebasercPath)) {
    return "";
  }
  return readJson(firebasercPath)?.projects?.default || "";
}

function toBoolean(value, fallback = false) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function buildRuntime(options, envConfig) {
  const useEmulator =
    typeof options.useEmulator === "boolean" ? options.useEmulator : toBoolean(envConfig.FIREBASE_USE_EMULATORS, false);
  const projectId = options.projectId || envConfig.FIREBASE_PROJECT_ID || getDefaultProjectId();
  const host = options.host || envConfig.FIREBASE_EMULATOR_HOST || "127.0.0.1";
  const authPort = options.authPort || Number.parseInt(envConfig.FIREBASE_AUTH_EMULATOR_PORT || "", 10) || 9099;
  const firestorePort =
    options.firestorePort || Number.parseInt(envConfig.FIREBASE_FIRESTORE_EMULATOR_PORT || "", 10) || 8080;
  if (!projectId) {
    throw new Error("找不到 Firebase project id，請確認 .firebaserc、.env 或 --project。");
  }
  return { useEmulator, projectId, host, authPort, firestorePort };
}

function validateOptions(options) {
  if (!options.uid && !options.email) {
    throw new Error("請至少指定 --uid 或 --email 其中一個。");
  }
  if (options.fromMonth && !/^\d{4}-\d{2}$/.test(options.fromMonth)) {
    throw new Error("--from 格式必須是 YYYY-MM。");
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function monthKey(value) {
  return String(value || "").slice(0, 7);
}

function parseMonth(month) {
  const [year, value] = String(month || "").split("-").map(Number);
  return { year, month: value };
}

function compareMonthKeys(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function incrementMonth(month) {
  const { year, month: value } = parseMonth(month);
  const date = new Date(year, value - 1, 1);
  date.setMonth(date.getMonth() + 1);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function listMonths(fromMonth, toMonth) {
  const months = [];
  if (!fromMonth || !toMonth) {
    return months;
  }
  let current = fromMonth;
  while (compareMonthKeys(current, toMonth) <= 0) {
    months.push(current);
    current = incrementMonth(current);
  }
  return months;
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

function getTransactionType(transaction) {
  const fromType = getCategoryFlowType(transaction.fromItem.type);
  const toType = getCategoryFlowType(transaction.toItem.type);
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

function getRefreshToken() {
  const configPath = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  const config = readJson(configPath);
  const refreshToken = config?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("找不到 Firebase CLI refresh token。請先執行 npm run firebase:login。");
  }
  return refreshToken;
}

async function getAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: FIREBASE_CLIENT_ID,
      client_secret: FIREBASE_CLIENT_SECRET,
      refresh_token: getRefreshToken(),
      grant_type: "refresh_token"
    })
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(`取得 access token 失敗：${payload.error || response.status}`);
  }
  return payload.access_token;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function getFirestoreDocumentsBase(runtime) {
  if (runtime.useEmulator) {
    return `http://${runtime.host}:${runtime.firestorePort}/v1/projects/${runtime.projectId}/databases/(default)/documents`;
  }
  return `https://firestore.googleapis.com/v1/projects/${runtime.projectId}/databases/(default)/documents`;
}

function firestoreHeaders(accessToken) {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

function decodeFirestoreValue(value) {
  if ("stringValue" in value) {
    return value.stringValue;
  }
  if ("integerValue" in value) {
    return Number(value.integerValue);
  }
  if ("doubleValue" in value) {
    return Number(value.doubleValue);
  }
  if ("booleanValue" in value) {
    return Boolean(value.booleanValue);
  }
  if ("nullValue" in value) {
    return null;
  }
  if ("mapValue" in value) {
    return decodeFirestoreFields(value.mapValue.fields || {});
  }
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  return "";
}

function decodeFirestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFirestoreFields(value) } };
  }
  return { stringValue: String(value) };
}

function encodeFirestoreFields(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, encodeFirestoreValue(value)]));
}

function normalizeSettingsDocument(settings) {
  return {
    monthlyBudget: Number(settings?.monthlyBudget || 0),
    recurringAppliedMonth: String(settings?.recurringAppliedMonth || "").trim(),
    snapshotDirtyFromMonth: String(settings?.snapshotDirtyFromMonth || "").trim()
  };
}

async function listCollectionDocuments(runtime, accessToken, collectionPath) {
  const result = [];
  let pageToken = "";
  do {
    const url = new URL(`${getFirestoreDocumentsBase(runtime)}/${collectionPath}`);
    url.searchParams.set("pageSize", "500");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const payload = await fetchJson(url, {
      headers: firestoreHeaders(accessToken)
    });
    for (const document of payload.documents || []) {
      result.push({
        id: document.name.split("/").pop(),
        ...decodeFirestoreFields(document.fields || {})
      });
    }
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return result;
}

async function getDocument(runtime, accessToken, documentPath) {
  try {
    const payload = await fetchJson(`${getFirestoreDocumentsBase(runtime)}/${documentPath}`, {
      headers: firestoreHeaders(accessToken)
    });
    return {
      id: payload.name.split("/").pop(),
      ...decodeFirestoreFields(payload.fields || {})
    };
  } catch (error) {
    if (String(error.message || "").includes("404")) {
      return null;
    }
    throw error;
  }
}

async function listEmulatorAccounts(runtime) {
  const tempFile = path.join(os.tmpdir(), `firebase-auth-emulator-export-${Date.now()}.json`);
  try {
    execFileSync(
      "npx",
      ["--yes", "firebase-tools", "auth:export", tempFile, "--format=json", "--project", runtime.projectId],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          FIREBASE_AUTH_EMULATOR_HOST: `${runtime.host}:${runtime.authPort}`
        }
      }
    );
    return readJson(tempFile).users || [];
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

function exportAuthUsers(projectId) {
  const tempFile = path.join(os.tmpdir(), `firebase-auth-export-${Date.now()}.json`);
  try {
    execFileSync(
      "npx",
      ["--yes", "firebase-tools", "auth:export", tempFile, "--format=json", "--project", projectId],
      { stdio: "pipe" }
    );
    return readJson(tempFile).users || [];
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

async function resolveTargetUid(runtime, options) {
  if (options.uid) {
    return options.uid;
  }
  if (runtime.useEmulator) {
    const accounts = await listEmulatorAccounts(runtime);
    const matched = accounts.find((item) => String(item.email || "").toLowerCase() === options.email.toLowerCase());
    if (!matched?.localId) {
      throw new Error(`在 Auth Emulator 找不到 email：${options.email}`);
    }
    return matched.localId;
  }
  const users = exportAuthUsers(runtime.projectId);
  const matched = users.find((item) => String(item.email || "").toLowerCase() === options.email.toLowerCase());
  if (!matched?.localId) {
    throw new Error(`在 Firebase Authentication 找不到 email：${options.email}`);
  }
  return matched.localId;
}

function compareTransactionsAscending(a, b) {
  const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
  if (dateCompare !== 0) {
    return dateCompare;
  }
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function buildItemMaps(accounts, categories) {
  return {
    accountsById: new Map(accounts.map((account) => [account.id, account])),
    categoriesById: new Map(categories.map((category) => [category.id, category]))
  };
}

function resolveTransactionItem(item, maps) {
  if (!item?.kind || !item?.id) {
    return { kind: "", id: "", name: "", type: "" };
  }
  if (item.kind === "account") {
    const account = maps.accountsById.get(item.id);
    return {
      kind: "account",
      id: item.id,
      name: account?.name || item.name || "",
      type: account ? inferAccountType(account) : item.type || ""
    };
  }
  if (item.kind === "category") {
    const category = maps.categoriesById.get(item.id);
    return {
      kind: "category",
      id: item.id,
      name: category?.name || item.name || "",
      type: category?.type || item.type || ""
    };
  }
  return { kind: "", id: "", name: "", type: "" };
}

function applyTransactionToBalances(balances, transaction) {
  const amount = Number(transaction.amount || 0);
  const type = getTransactionType(transaction);
  const fromItem = transaction.fromItem;
  const toItem = transaction.toItem;

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

function buildSnapshots(accounts, categories, transactions, requestedFromMonth = "", dirtyFromMonth = "") {
  const maps = buildItemMaps(accounts, categories);
  const transactionsAscending = [...transactions]
    .map((transaction) => ({
      ...transaction,
      fromItem: resolveTransactionItem(transaction.fromItem, maps),
      toItem: resolveTransactionItem(transaction.toItem, maps)
    }))
    .sort(compareTransactionsAscending);

  const months = [...new Set(transactionsAscending.map((transaction) => monthKey(transaction.date)).filter(Boolean))].sort(compareMonthKeys);
  const firstTransactionMonth = months[0] || "";
  const lastTransactionMonth = months[months.length - 1] || "";
  const candidateFrom = [requestedFromMonth, dirtyFromMonth, firstTransactionMonth].filter(Boolean).sort(compareMonthKeys)[0] || "";
  if (!candidateFrom || !lastTransactionMonth) {
    return {
      fromMonth: "",
      toMonth: "",
      snapshotDocs: [],
      transactionCount: transactionsAscending.length,
      monthsWithTransactions: months
    };
  }

  const targetMonths = listMonths(candidateFrom, lastTransactionMonth);
  const balances = Object.fromEntries(accounts.map((account) => [account.id, Number(account.balance || 0)]));
  const snapshotDocs = [];
  let pointer = 0;

  for (const month of targetMonths) {
    const monthCategoryTotals = new Map();
    let incomeTotal = 0;
    let expenseTotal = 0;
    let sourceLastTransactionDate = "";

    while (pointer < transactionsAscending.length && compareMonthKeys(monthKey(transactionsAscending[pointer].date), month) < 0) {
      applyTransactionToBalances(balances, transactionsAscending[pointer]);
      pointer += 1;
    }

    while (pointer < transactionsAscending.length && monthKey(transactionsAscending[pointer].date) === month) {
      const transaction = transactionsAscending[pointer];
      const type = getTransactionType(transaction);
      const amount = Number(transaction.amount || 0);
      applyTransactionToBalances(balances, transaction);
      if (type === "income") {
        incomeTotal += amount;
        if (transaction.fromItem.kind === "category" && transaction.fromItem.id) {
          monthCategoryTotals.set(transaction.fromItem.id, (monthCategoryTotals.get(transaction.fromItem.id) || 0) + amount);
        }
      } else if (type === "expense") {
        expenseTotal += amount;
        if (transaction.toItem.kind === "category" && transaction.toItem.id) {
          monthCategoryTotals.set(transaction.toItem.id, (monthCategoryTotals.get(transaction.toItem.id) || 0) + amount);
        }
      } else if (type === "refund") {
        expenseTotal -= amount;
        if (transaction.fromItem.kind === "category" && transaction.fromItem.id) {
          monthCategoryTotals.set(transaction.fromItem.id, (monthCategoryTotals.get(transaction.fromItem.id) || 0) - amount);
        }
      }
      sourceLastTransactionDate = transaction.date || sourceLastTransactionDate;
      pointer += 1;
    }

    const closingBalances = {};
    accounts.forEach((account) => {
      closingBalances[account.id] = Number(balances[account.id] || 0);
    });

    const netWorth = accounts.reduce((sum, account) => {
      const value = Number(closingBalances[account.id] || 0);
      return sum + (inferAccountType(account) === "liability" ? -value : value);
    }, 0);

    snapshotDocs.push({
      month,
      data: {
        month,
        closingBalances,
        incomeTotal,
        expenseTotal,
        categoryTotals: Object.fromEntries([...monthCategoryTotals.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
        netWorth,
        rebuiltAt: Date.now(),
        sourceLastTransactionDate: sourceLastTransactionDate || ""
      }
    });
  }

  return {
    fromMonth: candidateFrom,
    toMonth: lastTransactionMonth,
    snapshotDocs,
    transactionCount: transactionsAscending.length,
    monthsWithTransactions: months
  };
}

async function writeDocument(runtime, accessToken, documentPath, data) {
  const url = `${getFirestoreDocumentsBase(runtime)}/${documentPath}`;
  await fetchJson(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...firestoreHeaders(accessToken)
    },
    body: JSON.stringify({ fields: encodeFirestoreFields(data) })
  });
}

async function rebuildMonthlySnapshots(runtime, accessToken, uid, options) {
  const [accounts, categories, transactions, settings] = await Promise.all([
    listCollectionDocuments(runtime, accessToken, `users/${uid}/accounts`),
    listCollectionDocuments(runtime, accessToken, `users/${uid}/categories`),
    listCollectionDocuments(runtime, accessToken, `users/${uid}/transactions`),
    getDocument(runtime, accessToken, `users/${uid}/meta/settings`)
  ]);

  const dirtyFromMonth = String(settings?.snapshotDirtyFromMonth || "").trim();
  const summary = buildSnapshots(accounts, categories, transactions, options.fromMonth, dirtyFromMonth);

  const messages = [
    `目標環境：${runtime.useEmulator ? "Firebase Emulator" : "正式 Firestore"}。`,
    `目標使用者：${uid}。`,
    `帳戶數：${accounts.length}。`,
    `分類數：${categories.length}。`,
    `記錄數：${summary.transactionCount}。`
  ];

  if (!summary.snapshotDocs.length) {
    messages.push("沒有可重建的月快照。");
    if (dirtyFromMonth) {
      messages.push(`目前 dirty month：${dirtyFromMonth}。`);
    }
    return messages;
  }

  messages.push(`重建區間：${summary.fromMonth} ~ ${summary.toMonth}。`);
  messages.push(`快照月份數：${summary.snapshotDocs.length}。`);
  if (dirtyFromMonth) {
    messages.push(`目前 dirty month：${dirtyFromMonth}。`);
  }

  if (!options.apply) {
    messages.push("目前是 dry-run。加上 --apply 才會真的寫入 monthlySnapshots 並清掉 dirty flag。");
    return messages;
  }

  for (const snapshot of summary.snapshotDocs) {
    await writeDocument(runtime, accessToken, `users/${uid}/monthlySnapshots/${snapshot.month}`, snapshot.data);
  }

  const nextSettings = {
    ...normalizeSettingsDocument(settings),
    snapshotDirtyFromMonth: ""
  };
  await writeDocument(runtime, accessToken, `users/${uid}/meta/settings`, nextSettings);
  messages.push("已寫入 monthlySnapshots，並清除 snapshotDirtyFromMonth。");
  return messages;
}

async function main() {
  const options = parseArgs(process.argv);
  validateOptions(options);
  const envConfig = parseEnvFile(options.envFile);
  const runtime = buildRuntime(options, envConfig);
  const accessToken = runtime.useEmulator ? "owner" : await getAccessToken();
  const uid = await resolveTargetUid(runtime, options);
  const messages = await rebuildMonthlySnapshots(runtime, accessToken, uid, options);
  console.log(messages.join("\n"));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
