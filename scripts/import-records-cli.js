#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const FIREBASE_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

function printUsage() {
  console.log(`用法：
  npm run import:records -- --csv <檔案路徑> (--uid <uid> | --email <email>) [--emulator | --production] [--apply]

參數：
  --csv <path>         記錄 CSV 檔案
  --uid <uid>          直接指定匯入的 Firebase Auth uid
  --email <email>      以 email 查出匯入的 Firebase Auth uid
  --emulator           連到 Firebase Emulator
  --production         連到正式 Firestore
  --apply              實際寫入；未指定時只做 dry-run
  --env-file <path>    指定 .env，預設為專案根目錄 .env
  --host <host>        覆寫 Emulator host
  --auth-port <port>   覆寫 Auth Emulator port
  --firestore-port <port> 覆寫 Firestore Emulator port
  --project <id>       覆寫 Firebase project id
  --help               顯示說明

範例：
  npm run import:records -- --csv ./records.csv --uid abc123 --emulator
  npm run import:records -- --csv ./records.csv --email you@example.com --production --apply`);
}

function parseArgs(argv) {
  const options = {
    csvPath: "",
    uid: "",
    email: "",
    useEmulator: null,
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
    if (arg === "--csv" && argv[index + 1]) {
      options.csvPath = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
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
  if (!options.csvPath) {
    throw new Error("缺少 --csv <檔案路徑>。");
  }
  if (!fs.existsSync(options.csvPath)) {
    throw new Error(`找不到 CSV 檔案：${options.csvPath}`);
  }
  if (!options.uid && !options.email) {
    throw new Error("請至少指定 --uid 或 --email 其中一個。");
  }
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

function pad2(value) {
  return String(value).padStart(2, "0");
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

function isValidTransactionRoute(fromItem, toItem) {
  return Boolean(fromItem.type && toItem.type);
}

function isValidTransactionPayload(transaction) {
  return isValidDateKey(transaction.date) && Number.isFinite(transaction.amount) && transaction.amount > 0;
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

function getAuthBase(runtime) {
  if (runtime.useEmulator) {
    return `http://${runtime.host}:${runtime.authPort}`;
  }
  return "https://identitytoolkit.googleapis.com/v1";
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

function buildItemResolver(accounts, categories) {
  const byName = new Map();
  accounts.forEach((account) => {
    byName.set(account.name, {
      kind: "account",
      id: account.id,
      name: account.name,
      type: inferAccountType(account)
    });
  });
  categories.forEach((category) => {
    byName.set(category.name, {
      kind: "category",
      id: category.id,
      name: category.name,
      type: category.type
    });
  });
  return (name) => {
    const text = String(name || "").trim();
    return byName.get(text) || { kind: "", id: "", name: "", type: "" };
  };
}

function compactTransactionItem(item) {
  return {
    kind: item.kind || "",
    id: item.id || ""
  };
}

function newDocumentName(runtime, uid) {
  return `projects/${runtime.projectId}/databases/(default)/documents/users/${uid}/transactions/${crypto.randomBytes(10).toString("hex")}`;
}

async function commitWrites(runtime, accessToken, writes) {
  if (!writes.length) {
    return;
  }
  const url = `${getFirestoreDocumentsBase(runtime)}:commit`;
  await fetchJson(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...firestoreHeaders(accessToken)
    },
    body: JSON.stringify({ writes })
  });
}

async function importRecords(runtime, accessToken, uid, csvText, apply) {
  const rows = parseCsv(csvText);
  const headers = rows.shift() || [];
  const requiredHeaders = ["日期", "從項目", "至項目", "金額"];
  const missingHeaders = requiredHeaders.filter((header) => !headers.some((value) => String(value || "").trim() === header));
  if (missingHeaders.length) {
    throw new Error(`匯入失敗：缺少欄位 ${missingHeaders.join("、")}。`);
  }

  const [accounts, categories] = await Promise.all([
    listCollectionDocuments(runtime, accessToken, `users/${uid}/accounts`),
    listCollectionDocuments(runtime, accessToken, `users/${uid}/categories`)
  ]);
  const resolveImportItem = buildItemResolver(accounts, categories);

  const dataRowCount = rows.length;
  let importedCount = 0;
  let missingItemSkippedCount = 0;
  const missingItemSamples = [];
  let invalidRouteSkippedCount = 0;
  const invalidRouteSamples = [];
  let invalidPayloadSkippedCount = 0;
  const invalidPayloadSamples = [];
  let writes = [];

  for (const row of rows) {
    const record = rowToObject(headers, row);
    const fromItem = resolveImportItem(record["從項目"]);
    const toItem = resolveImportItem(record["至項目"]);
    const missingNames = [record["從項目"], record["至項目"]]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .filter((value, index) => {
        if (index === 0) {
          return fromItem.kind === "";
        }
        return toItem.kind === "";
      });
    if (missingNames.length) {
      missingItemSkippedCount += 1;
      if (missingItemSamples.length < 10) {
        missingItemSamples.push(missingNames.join(" / "));
      }
      continue;
    }

    const payload = {
      date: normalizeImportedDate(record["日期"]),
      fromItem: compactTransactionItem(fromItem),
      toItem: compactTransactionItem(toItem),
      amount: Number(record["金額"] || 0),
      note: String(record["摘要"] || ""),
      memo: String(record["備註"] || "")
    };

    if (!isValidTransactionRoute(fromItem, toItem)) {
      invalidRouteSkippedCount += 1;
      if (invalidRouteSamples.length < 10) {
        invalidRouteSamples.push(`${String(record["從項目"] || "").trim()} -> ${String(record["至項目"] || "").trim()}`);
      }
      continue;
    }

    if (!isValidTransactionPayload(payload)) {
      invalidPayloadSkippedCount += 1;
      if (invalidPayloadSamples.length < 10) {
        invalidPayloadSamples.push(
          `日期:${String(record["日期"] || "").trim()} -> ${payload.date} / 金額:${String(record["金額"] || "").trim()}`
        );
      }
      continue;
    }

    importedCount += 1;

    if (!apply) {
      continue;
    }

    writes.push({
      update: {
        name: newDocumentName(runtime, uid),
        fields: encodeFirestoreFields(payload)
      }
    });

    if (writes.length >= 200) {
      await commitWrites(runtime, accessToken, writes);
      writes = [];
    }
  }

  if (apply && writes.length) {
    await commitWrites(runtime, accessToken, writes);
  }

  const messages = [
    `${apply ? "已匯入" : "可匯入"} ${importedCount} 筆記錄。`,
    `CSV 資料列：${dataRowCount} 筆。`,
    `目標環境：${runtime.useEmulator ? "Firebase Emulator" : "正式 Firestore"}。`,
    `目標使用者：${uid}。`,
    `交易類型摘要：收入/支出/支付/預借/退款 會依從項目與至項目自動判定。`
  ];
  if (!apply) {
    messages.push("目前是 dry-run。加上 --apply 才會真的寫入。");
  }
  if (dataRowCount === 0) {
    messages.push("沒有讀到任何資料列，請確認第一行之後真的有資料，並以 CSV、分號分隔或 Tab 分隔格式儲存。");
  }
  if (missingItemSkippedCount > 0) {
    messages.push(`因項目不存在而略過 ${missingItemSkippedCount} 筆。`);
    messages.push(`缺少項目名稱（前 10 筆）：${missingItemSamples.join("、")}`);
  }
  if (invalidRouteSkippedCount > 0) {
    messages.push(`因項目組合不成立而略過 ${invalidRouteSkippedCount} 筆。`);
    messages.push(`不成立組合（前 10 筆）：${invalidRouteSamples.join("、")}`);
  }
  if (invalidPayloadSkippedCount > 0) {
    messages.push(`因日期或金額格式不正確而略過 ${invalidPayloadSkippedCount} 筆。`);
    messages.push(`格式不正確（前 10 筆）：${invalidPayloadSamples.join("、")}`);
  }
  return messages;
}

async function main() {
  const options = parseArgs(process.argv);
  validateOptions(options);
  const envConfig = parseEnvFile(options.envFile);
  const runtime = buildRuntime(options, envConfig);
  const accessToken = runtime.useEmulator ? "owner" : await getAccessToken();
  const uid = await resolveTargetUid(runtime, options);
  const csvText = fs.readFileSync(options.csvPath, "utf8");
  const messages = await importRecords(runtime, accessToken, uid, csvText, options.apply);
  console.log(messages.join("\n"));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
