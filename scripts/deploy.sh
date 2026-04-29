#!/usr/bin/env bash
set -euo pipefail

if ! command -v firebase >/dev/null 2>&1; then
  echo "❌ 找不到 firebase CLI，請先執行：npm i -g firebase-tools"
  exit 1
fi

if [[ ! -f app-config.js && ! -f firebase-config.js ]]; then
  echo "❌ 找不到 app-config.js 或 firebase-config.js，請先產生設定檔"
  exit 1
fi

if [[ ! -f .firebaserc ]]; then
  echo "❌ 找不到 .firebaserc，請先複製 .firebaserc.example 並設定專案 ID"
  exit 1
fi

echo "🚀 開始部署到 Firebase Hosting..."
firebase deploy --only hosting

echo "✅ 部署完成"
