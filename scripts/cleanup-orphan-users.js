#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const FIREBASE_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

function printUsage() {
  console.log(`用法：
  npm run cleanup:orphan-users
  npm run cleanup:orphan-users:apply -- --confirm-project <projectId>
  node scripts/cleanup-orphan-users.js [--project <projectId>] [--apply --confirm-project <projectId>]

參數：
  --project <id>          覆寫 .firebaserc 的 default project id
  --apply                 實際遞迴刪除孤兒 users/{uid}
  --confirm-project <id>  真的刪除前，再次明確確認目標 project id
  --help                  顯示說明`);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    projectId: "",
    confirmProject: ""
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--project" && argv[index + 1]) {
      options.projectId = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (arg === "--confirm-project" && argv[index + 1]) {
      options.confirmProject = String(argv[index + 1]).trim();
      index += 1;
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getDefaultProjectId() {
  const configPath = path.join(process.cwd(), ".firebaserc");
  if (!fs.existsSync(configPath)) {
    return "";
  }
  return readJson(configPath)?.projects?.default || "";
}

function getProjectId(options) {
  const projectId = options.projectId || getDefaultProjectId();
  if (!projectId) {
    throw new Error("找不到 Firebase project id，請確認 .firebaserc 或加上 --project <id>。");
  }
  return projectId;
}

function getRefreshToken() {
  const configPath = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  const config = readJson(configPath);
  const refreshToken = config?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("找不到 Firebase CLI refresh token。請先執行 firebase login。");
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

function exportAuthUserIds(projectId) {
  const tempFile = path.join(os.tmpdir(), `firebase-auth-export-${Date.now()}.json`);
  try {
    execFileSync(
      "npx",
      ["--yes", "firebase-tools", "auth:export", tempFile, "--format=json", "--project", projectId],
      { stdio: "pipe" }
    );
    const data = readJson(tempFile);
    return new Set((data.users || []).map((user) => user.localId).filter(Boolean));
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

async function listFirestoreUserIds(projectId, accessToken) {
  const ids = [];
  let pageToken = "";
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("mask.fieldPaths", "__name__");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`讀取 Firestore users 失敗：${payload.error?.message || response.status}`);
    }
    for (const document of payload.documents || []) {
      ids.push(document.name.split("/").pop());
    }
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return ids;
}

function deleteFirestoreUser(projectId, uid) {
  execFileSync(
    "npx",
    [
      "--yes",
      "firebase-tools",
      "firestore:delete",
      `users/${uid}`,
      "--recursive",
      "--force",
      "--project",
      projectId
    ],
    { stdio: "inherit" }
  );
}

async function main() {
  const options = parseArgs(process.argv);
  const projectId = getProjectId(options);
  if (options.apply && options.confirmProject !== projectId) {
    throw new Error(`這是刪除操作。請加上 --confirm-project ${projectId} 再執行一次。`);
  }
  const accessToken = await getAccessToken();
  const authUserIds = exportAuthUserIds(projectId);
  const firestoreUserIds = await listFirestoreUserIds(projectId, accessToken);
  const orphanUserIds = firestoreUserIds.filter((uid) => !authUserIds.has(uid));

  console.log(`project: ${projectId}`);
  console.log(`auth users: ${authUserIds.size}`);
  console.log(`firestore users: ${firestoreUserIds.length}`);
  console.log(`orphan firestore users: ${orphanUserIds.length}`);

  if (!orphanUserIds.length) {
    console.log("沒有找到需要刪除的孤兒使用者資料。");
    return;
  }

  orphanUserIds.forEach((uid) => console.log(`- ${uid}`));

  if (!options.apply) {
    console.log("這是 dry-run。加上 --apply 才會實際刪除。");
    return;
  }

  for (const uid of orphanUserIds) {
    console.log(`刪除 users/${uid} ...`);
    deleteFirestoreUser(projectId, uid);
  }

  console.log("清理完成。");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
