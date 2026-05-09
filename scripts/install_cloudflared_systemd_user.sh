#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace_root="$(cd "${repo_root}/.." && pwd)"
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

default_cloudflared_bin="${repo_root}/cloudflared/cloudflared"
if [[ ! -x "$default_cloudflared_bin" ]]; then
  for candidate in \
    "${workspace_root}/cloudflared/cloudflared-linux-amd64" \
    "${workspace_root}/cloudflared/cloudflared-linux-arm64" \
    "${workspace_root}/cloudflared/cloudflared"; do
    if [[ -x "$candidate" ]]; then
      default_cloudflared_bin="$candidate"
      break
    fi
  done
fi
if [[ ! -x "$default_cloudflared_bin" ]] && command -v cloudflared >/dev/null 2>&1; then
  default_cloudflared_bin="$(command -v cloudflared)"
fi
if [[ -z "$npm_bin" ]] && command -v npm >/dev/null 2>&1; then
  npm_bin="$(command -v npm)"
fi
cloudflared_bin="${CLOUDFLARED_BIN:-${default_cloudflared_bin}}"
tunnel_name="${TUNNEL_NAME:-}"
tunnel_id="${TUNNEL_ID:-}"
public_hostname="${PUBLIC_HOSTNAME:-}"
run_route_dns="${RUN_ROUTE_DNS:-0}"

frontend_service="${service_prefix}-frontend.service"
cloudflared_service="${service_prefix}-cloudflared.service"

usage() {
  cat <<EOF
用途：
  安裝 finance-tracker-sqlite 的 user-level systemd services：
  1. 啟動 npm run sqlite:frontend
  2. 啟動 cloudflared tunnel run

必要環境變數：
  PUBLIC_ORIGIN     對外網址，例如 https://moneybook.example.com
  LOGIN_EMAIL       bridge 登入 email
  LOGIN_PASSWORD    bridge 登入 password
  TUNNEL_NAME       cloudflared tunnel 名稱

常用可選環境變數：
  DB_PATH           預設: ${HOME}/finance-tracker.db
  USER_ID           預設: local-user
  BRIDGE_HOST       預設: 127.0.0.1
  SERVE_HOST        預設: 127.0.0.1
  CLOUDFLARED_BIN   預設: ${cloudflared_bin}
  NPM_BIN           預設: ${npm_bin:-<command -v npm>}
  SERVICE_PREFIX    預設: ${service_prefix}

一次性 DNS route：
  若要在安裝時順便執行 cloudflared tunnel route dns，另外提供：
  RUN_ROUTE_DNS=1
  TUNNEL_ID=<tunnel-id>
  PUBLIC_HOSTNAME=<hostname>

範例：
  PUBLIC_ORIGIN=https://moneybook.example.com \\
  LOGIN_EMAIL=you@example.com \\
  LOGIN_PASSWORD='<strong-password>' \\
  TUNNEL_NAME=<cloudflared-tunnel-name> \\
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
require_value "TUNNEL_NAME" "$tunnel_name"

if [[ "$run_route_dns" == "1" ]]; then
  require_value "TUNNEL_ID" "$tunnel_id"
  require_value "PUBLIC_HOSTNAME" "$public_hostname"
fi

if [[ ! -f "${repo_root}/package.json" ]]; then
  echo "找不到 package.json，請在 repo 內執行此腳本。" >&2
  exit 1
fi

if [[ ! -x "$cloudflared_bin" ]]; then
  echo "找不到可執行的 cloudflared: $cloudflared_bin" >&2
  exit 1
fi
if [[ ! -x "$npm_bin" ]]; then
  echo "找不到可執行的 npm: $npm_bin" >&2
  exit 1
fi

mkdir -p "$unit_dir"

escaped_repo_root="$(systemd_escape "$repo_root")"
escaped_db_path="$(systemd_escape "$db_path")"
escaped_user_id="$(systemd_escape "$user_id")"
escaped_bridge_host="$(systemd_escape "$bridge_host")"
escaped_serve_host="$(systemd_escape "$serve_host")"
escaped_public_origin="$(systemd_escape "$public_origin")"
escaped_login_email="$(systemd_escape "$login_email")"
escaped_login_password="$(systemd_escape "$login_password")"
escaped_cloudflared_bin="$(systemd_escape "$cloudflared_bin")"
escaped_tunnel_name="$(systemd_escape "$tunnel_name")"
escaped_npm_bin="$(systemd_escape "$npm_bin")"

frontend_service_path="${unit_dir}/${frontend_service}"
cloudflared_service_path="${unit_dir}/${cloudflared_service}"
escaped_env_file="$(systemd_escape "$env_file")"

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

cat >"$cloudflared_service_path" <<EOF
[Unit]
Description=Finance Tracker SQLite cloudflared tunnel
After=network-online.target ${frontend_service}
Wants=network-online.target ${frontend_service}

[Service]
Type=simple
EnvironmentFile=${escaped_env_file}
ExecStart=/usr/bin/env bash -lc 'exec "$CLOUDFLARED_BIN" tunnel run "$TUNNEL_NAME"'
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
CLOUDFLARED_BIN=$(envfile_quote "$cloudflared_bin")
TUNNEL_NAME=$(envfile_quote "$tunnel_name")
NPM_BIN=$(envfile_quote "$npm_bin")
PATH=$(envfile_quote "$(dirname "$npm_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
EOF
chmod 600 "$env_file"

if [[ "$run_route_dns" == "1" ]]; then
  echo "執行一次性 DNS route: ${public_hostname} -> tunnel ${tunnel_id}"
  "$cloudflared_bin" tunnel route dns "$tunnel_id" "$public_hostname"
fi

systemctl --user daemon-reload
systemctl --user enable --now "$frontend_service" "$cloudflared_service"

echo "Installed service: ${frontend_service_path}"
echo "Installed service: ${cloudflared_service_path}"
echo "Installed env file: ${env_file}"
echo "Check status:"
echo "  systemctl --user status ${frontend_service}"
echo "  systemctl --user status ${cloudflared_service}"
echo "Follow logs:"
echo "  journalctl --user -u ${frontend_service} -f"
echo "  journalctl --user -u ${cloudflared_service} -f"
