#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const cwd = process.cwd();

function parseArgs(argv) {
  const options = {
    envFile: path.join(cwd, ".env"),
    output: path.join(cwd, "firebase-config.js")
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file" && argv[index + 1]) {
      options.envFile = path.resolve(cwd, argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--output" && argv[index + 1]) {
      options.output = path.resolve(cwd, argv[index + 1]);
      index += 1;
    }
  }

  return options;
}

function parseEnvFile(filePath) {
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

function readConfig(options) {
  if (fs.existsSync(options.envFile)) {
    return parseEnvFile(options.envFile);
  }

  if (fs.existsSync(options.output)) {
    console.log(`略過產生：找不到 ${path.basename(options.envFile)}，保留既有 ${path.basename(options.output)}。`);
    process.exit(0);
  }

  throw new Error(`找不到 ${path.basename(options.envFile)}，也沒有既有 firebase-config.js 可沿用。`);
}

function requireKeys(config, keys) {
  const missing = keys.filter((key) => !String(config[key] || "").trim());
  if (missing.length) {
    throw new Error(`缺少必要設定：${missing.join(", ")}`);
  }
}

function toBoolean(value, fallback = false) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function writeConfigFile(outputPath, config) {
  const firebaseConfig = {
    apiKey: config.FIREBASE_API_KEY,
    authDomain: config.FIREBASE_AUTH_DOMAIN,
    projectId: config.FIREBASE_PROJECT_ID,
    storageBucket: config.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: config.FIREBASE_MESSAGING_SENDER_ID,
    appId: config.FIREBASE_APP_ID
  };

  const firebaseRuntime = {
    useEmulators: toBoolean(config.FIREBASE_USE_EMULATORS, false),
    emulatorHost: String(config.FIREBASE_EMULATOR_HOST || "").trim(),
    authEmulatorPort: toInteger(config.FIREBASE_AUTH_EMULATOR_PORT, 9099),
    firestoreEmulatorPort: toInteger(config.FIREBASE_FIRESTORE_EMULATOR_PORT, 8080),
    emulatorUiPort: toInteger(config.FIREBASE_EMULATOR_UI_PORT, 4000)
  };

  const content = `// 此檔案由 scripts/generate-firebase-config.js 產生，請勿手動編輯。\nexport const firebaseConfig = ${JSON.stringify(firebaseConfig, null, 2)};\n\nexport const firebaseRuntime = ${JSON.stringify(firebaseRuntime, null, 2)};\n`;
  fs.writeFileSync(outputPath, content, "utf8");
  console.log(`已產生 ${path.relative(cwd, outputPath)}。`);
}

function main() {
  const options = parseArgs(process.argv);
  const config = readConfig(options);
  requireKeys(config, [
    "FIREBASE_API_KEY",
    "FIREBASE_AUTH_DOMAIN",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_STORAGE_BUCKET",
    "FIREBASE_MESSAGING_SENDER_ID",
    "FIREBASE_APP_ID"
  ]);
  writeConfigFile(options.output, config);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
