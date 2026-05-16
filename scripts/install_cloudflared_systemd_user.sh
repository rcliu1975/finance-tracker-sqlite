#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${HOME}/.config/systemd/user"
config_dir="${HOME}/.config/finance-tracker-sqlite"
env_file="${config_dir}/systemd.env"
service_prefix="${SERVICE_PREFIX:-finance-tracker-sqlite}"

db_path="${DB_PATH:-${HOME}/finance-tracker.db}"
user_id="${USER_ID:-local-user}"
bridge_host="${BRIDGE_HOST:-127.0.0.1}"
serve_host="${SERVE_HOST:-127.0.0.1}"
public_origin="${PUBLIC_ORIGIN:-}"
login_email="${LOGIN_EMAIL:-}"
login_password="${LOGIN_PASSWORD:-}"
npm_bin="${NPM_BIN:-}"

if [[ -z "$npm_bin" ]] && command -v npm >/dev/null 2>&1; then
  npm_bin="$(command -v npm)"
fi

frontend_service="${service_prefix}-frontend.service"
legacy_cloudflared_service="${service_prefix}-cloudflared.service"

usage() {
  cat <<EOF
用途：
  安裝 finance-tracker-sqlite 的 user-level frontend service。
  cloudflared tunnel 已改由 /home/roger/WorkSpace/cloudflared-control/scripts/cloudflared-control.sh 集中管理。

必要環境變數：
  PUBLIC_ORIGIN     對外網址，例如 https://moneybook.example.com
  LOGIN_EMAIL       bridge 登入 email
  LOGIN_PASSWORD    bridge 登入 password

常用可選環境變數：
  DB_PATH           預設: ${HOME}/finance-tracker.db
  USER_ID           預設: local-user
  BRIDGE_HOST       預設: 127.0.0.1
  SERVE_HOST        預設: 127.0.0.1
  NPM_BIN           預設: ${npm_bin:-<command -v npm>}
  SERVICE_PREFIX    預設: ${service_prefix}

範例：
  PUBLIC_ORIGIN=https://moneybook.example.com \\
  LOGIN_EMAIL=you@example.com \\
  LOGIN_PASSWORD='<strong-password>' \\
  DB_PATH=${HOME}/finance-tracker.db \\
  bash scripts/install_cloudflared_systemd_user.sh
EOF
}

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "缺少必要環境變數: $name" >&2
    exit 1
  fi
}

systemd_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//%/%%}"
  value="${value// /\\x20}"
  value="${value//$'\t'/\\t}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

envfile_quote() {
  local value="$1"
  value="${value//\'/\'\\\'\'}"
  printf "'%s'" "$value"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_value "PUBLIC_ORIGIN" "$public_origin"
require_value "LOGIN_EMAIL" "$login_email"
require_value "LOGIN_PASSWORD" "$login_password"

if [[ ! -f "${repo_root}/package.json" ]]; then
  echo "找不到 package.json，請在 repo 內執行此腳本。" >&2
  exit 1
fi

if [[ ! -x "$npm_bin" ]]; then
  echo "找不到可執行的 npm: $npm_bin" >&2
  exit 1
fi

mkdir -p "$unit_dir"

escaped_repo_root="$(systemd_escape "$repo_root")"
escaped_env_file="$(systemd_escape "$env_file")"

frontend_service_path="${unit_dir}/${frontend_service}"
legacy_cloudflared_service_path="${unit_dir}/${legacy_cloudflared_service}"

cat >"$frontend_service_path" <<EOF
[Unit]
Description=Finance Tracker SQLite frontend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${escaped_repo_root}
EnvironmentFile=${escaped_env_file}
ExecStart=/usr/bin/env bash -lc 'exec "$NPM_BIN" run sqlite:frontend -- --db "$DB_PATH" --user-id "$USER_ID" --bridge-host "$BRIDGE_HOST" --serve-host "$SERVE_HOST" --public-origin "$PUBLIC_ORIGIN" --login-email-env LOGIN_EMAIL --login-password-env LOGIN_PASSWORD'
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

mkdir -p "$config_dir"
chmod 700 "$config_dir"
umask 077
cat >"$env_file" <<EOF
DB_PATH=$(envfile_quote "$db_path")
USER_ID=$(envfile_quote "$user_id")
BRIDGE_HOST=$(envfile_quote "$bridge_host")
SERVE_HOST=$(envfile_quote "$serve_host")
PUBLIC_ORIGIN=$(envfile_quote "$public_origin")
LOGIN_EMAIL=$(envfile_quote "$login_email")
LOGIN_PASSWORD=$(envfile_quote "$login_password")
NPM_BIN=$(envfile_quote "$npm_bin")
PATH=$(envfile_quote "$(dirname "$npm_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
EOF
chmod 600 "$env_file"

systemctl --user disable --now "$legacy_cloudflared_service" 2>/dev/null || true
rm -f "$legacy_cloudflared_service_path"

systemctl --user daemon-reload
systemctl --user enable --now "$frontend_service"

echo "Installed service: ${frontend_service_path}"
echo "Installed env file: ${env_file}"
echo "Removed legacy cloudflared service if present: ${legacy_cloudflared_service_path}"
echo "Cloudflared tunnel is now managed separately by:"
echo "  /home/roger/WorkSpace/cloudflared-control/scripts/cloudflared-control.sh"
echo "Check status:"
echo "  systemctl --user status ${frontend_service}"
echo "Follow logs:"
echo "  journalctl --user -u ${frontend_service} -f"
