#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate SQLite frontend config, start the SQLite bridge, then serve the frontend."
    )
    parser.add_argument("--db", required=True, help="SQLite database path.")
    parser.add_argument("--user-id", default="local-user", help="Target local user id.")
    parser.add_argument("--bridge-host", default="127.0.0.1", help="SQLite bridge bind host.")
    parser.add_argument("--bridge-port", type=int, default=8765, help="SQLite bridge bind port.")
    parser.add_argument("--serve-host", default="127.0.0.1", help="Frontend HTTP bind host.")
    parser.add_argument("--serve-port", type=int, default=5173, help="Frontend HTTP bind port.")
    parser.add_argument("--open-host", default="127.0.0.1", help="URL host printed for browser access.")
    parser.add_argument("--public-origin", default="", help="Public browser origin, e.g. https://moneybook.example.com")
    parser.add_argument("--public-bridge-path", default="/bridge", help="Public bridge path prefix when using same-origin proxy.")
    parser.add_argument("--login-email", default="", help="Enable external login with this email.")
    parser.add_argument("--login-password", default="", help="Enable external login with this password.")
    parser.add_argument("--login-email-env", default="", help="Read login email from this environment variable.")
    parser.add_argument("--login-password-env", default="", help="Read login password from this environment variable.")
    parser.add_argument(
        "--allow-unauthenticated",
        action="store_true",
        help="Start bridge without login. Use only for isolated local development.",
    )
    return parser.parse_args()


def resolve_secret(value: str, env_name: str, label: str) -> str:
    if str(value or "").strip():
        return str(value)
    env_key = str(env_name or "").strip()
    if not env_key:
        return ""
    if env_key not in os.environ:
        raise ValueError(f"{label} 指定的環境變數不存在：{env_key}")
    return str(os.environ.get(env_key, ""))


def normalize_public_origin(value: str) -> str:
    return str(value or "").strip().rstrip("/")


def normalize_public_path(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return "/bridge"
    return text if text.startswith("/") else f"/{text}"


def frontend_url_for_browser(args: argparse.Namespace) -> str:
    public_origin = normalize_public_origin(args.public_origin)
    if public_origin:
        return public_origin
    return f"http://{args.open_host}:{args.serve_port}"


def sqlite_api_base_url(args: argparse.Namespace) -> str:
    public_origin = normalize_public_origin(args.public_origin)
    if public_origin:
        return f"{public_origin}{normalize_public_path(args.public_bridge_path)}"
    return f"http://{args.open_host}:{args.bridge_port}"


def write_temp_env(args: argparse.Namespace) -> str:
    fd, path = tempfile.mkstemp(prefix="finance-tracker-sqlite-", suffix=".env")
    content = "\n".join(
        [
            "APP_STORAGE_BACKEND=sqlite",
            f"APP_LOCAL_USER_ID={args.user_id}",
            "APP_SQLITE_SEED_PATH=",
            f"APP_SQLITE_API_BASE_URL={sqlite_api_base_url(args)}",
            "",
        ]
    )
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
    return path


def wait_for_health(url: str, timeout_seconds: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=1.5) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"bridge 啟動逾時：{url}")


def bridge_health_host(bridge_host: str, open_host: str) -> str:
    host = str(bridge_host or "").strip()
    if host and host not in {"0.0.0.0", "::"}:
        return host
    public_host = str(open_host or "").strip()
    if public_host in {"", "0.0.0.0", "::"}:
        return "127.0.0.1"
    return public_host


def detect_local_ipv4_addresses() -> list[str]:
    addresses: set[str] = set()
    candidates = {socket.gethostname(), socket.getfqdn(), "localhost"}
    for name in candidates:
        try:
            for family, _, _, _, sockaddr in socket.getaddrinfo(name, None, socket.AF_INET):
                if family == socket.AF_INET and sockaddr and sockaddr[0] not in {"127.0.0.1", "0.0.0.0"}:
                    addresses.add(str(sockaddr[0]))
        except socket.gaierror:
            continue
    return sorted(addresses)


def terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parent.parent
    db_path = Path(args.db).expanduser().resolve()
    login_email = str(resolve_secret(args.login_email, args.login_email_env, "login email") or "").strip()
    login_password = resolve_secret(args.login_password, args.login_password_env, "login password")
    if not db_path.exists():
        raise FileNotFoundError(f"找不到 SQLite 資料庫：{db_path}")
    if bool(login_email) != bool(login_password):
        raise ValueError("如果要啟用 bridge 登入，必須同時指定 --login-email 與 --login-password。")
    if not (login_email and login_password) and not args.allow_unauthenticated:
        raise ValueError("SQLite frontend 預設需要 bridge 登入。請指定 --login-email-env/--login-password-env，或僅在隔離本機開發時加 --allow-unauthenticated。")

    temp_env_path = write_temp_env(args)
    bridge_process: subprocess.Popen[bytes] | None = None
    serve_process: subprocess.Popen[bytes] | None = None
    bridge_env = os.environ.copy()

    try:
        subprocess.run(
            [
                "node",
                "scripts/generate-app-config.js",
                "--env-file",
                temp_env_path,
                "--output",
                "app-config.js",
            ],
            cwd=repo_root,
            check=True,
        )

        frontend_url = frontend_url_for_browser(args)
        bridge_command = [
            "python3",
            "scripts/sqlite-http-bridge.py",
            "--db",
            str(db_path),
            "--user-id",
            args.user_id,
            "--host",
            args.bridge_host,
            "--port",
            str(args.bridge_port),
            "--cors-origin",
            frontend_url,
        ]
        if login_email and login_password:
            login_email_env = args.login_email_env or "FINANCE_TRACKER_SQLITE_LOGIN_EMAIL"
            login_password_env = args.login_password_env or "FINANCE_TRACKER_SQLITE_LOGIN_PASSWORD"
            bridge_env[login_email_env] = login_email
            bridge_env[login_password_env] = login_password
            bridge_command.extend(["--login-email-env", login_email_env, "--login-password-env", login_password_env])
        elif args.allow_unauthenticated:
            bridge_command.append("--allow-unauthenticated")

        bridge_process = subprocess.Popen(
            bridge_command,
            cwd=repo_root,
            env=bridge_env,
        )
        wait_for_health(f"http://{bridge_health_host(args.bridge_host, args.open_host)}:{args.bridge_port}/health")

        serve_process = subprocess.Popen(
            [
                "python3",
                "scripts/serve-static-frontend.py",
                "--root",
                str(repo_root),
                "--host",
                args.serve_host,
                "--port",
                str(args.serve_port),
            ],
            cwd=repo_root,
        )

        bridge_url = sqlite_api_base_url(args)
        print(f"SQLite bridge: {bridge_url}", flush=True)
        print(f"Frontend: {frontend_url}", flush=True)
        if login_email and login_password:
            print(f"登入帳號: {login_email}", flush=True)
        else:
            print("Bridge login: disabled", flush=True)
        if args.serve_host in {"0.0.0.0", "::"} or args.bridge_host in {"0.0.0.0", "::"}:
            local_ips = detect_local_ipv4_addresses()
            if local_ips:
                print("可用區網位址:", flush=True)
                for address in local_ips:
                    print(f"  Frontend: http://{address}:{args.serve_port}", flush=True)
                    print(f"  Bridge:   http://{address}:{args.bridge_port}", flush=True)
        print("按 Ctrl+C 可同時停止 bridge 與前端 server。", flush=True)

        while True:
            bridge_code = bridge_process.poll()
            serve_code = serve_process.poll()
            if bridge_code is not None:
                raise RuntimeError(f"sqlite bridge 已提前結束，exit code={bridge_code}")
            if serve_code is not None:
                raise RuntimeError(f"frontend server 已提前結束，exit code={serve_code}")
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        if serve_process is not None:
            terminate_process(serve_process)
        if bridge_process is not None:
            terminate_process(bridge_process)
        try:
            os.remove(temp_env_path)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
