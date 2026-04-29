#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
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
    parser.add_argument("--serve-host", default="0.0.0.0", help="Frontend HTTP bind host.")
    parser.add_argument("--serve-port", type=int, default=5173, help="Frontend HTTP bind port.")
    parser.add_argument("--open-host", default="127.0.0.1", help="URL host printed for browser access.")
    return parser.parse_args()


def write_temp_env(args: argparse.Namespace) -> str:
    fd, path = tempfile.mkstemp(prefix="finance-tracker-sqlite-", suffix=".env")
    api_base_url = f"http://{args.open_host}:{args.bridge_port}"
    content = "\n".join(
        [
            "APP_STORAGE_BACKEND=sqlite",
            f"APP_LOCAL_USER_ID={args.user_id}",
            "APP_SQLITE_SEED_PATH=",
            f"APP_SQLITE_API_BASE_URL={api_base_url}",
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
    if not db_path.exists():
        raise FileNotFoundError(f"找不到 SQLite 資料庫：{db_path}")

    temp_env_path = write_temp_env(args)
    bridge_process: subprocess.Popen[bytes] | None = None
    serve_process: subprocess.Popen[bytes] | None = None

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

        bridge_process = subprocess.Popen(
            [
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
            ],
            cwd=repo_root,
        )
        wait_for_health(f"http://{bridge_health_host(args.bridge_host, args.open_host)}:{args.bridge_port}/health")

        serve_process = subprocess.Popen(
            [
                "python3",
                "-m",
                "http.server",
                str(args.serve_port),
                "--bind",
                args.serve_host,
            ],
            cwd=repo_root,
        )

        frontend_url = f"http://{args.open_host}:{args.serve_port}"
        bridge_url = f"http://{args.open_host}:{args.bridge_port}"
        print(f"SQLite bridge: {bridge_url}")
        print(f"Frontend: {frontend_url}")
        print("按 Ctrl+C 可同時停止 bridge 與前端 server。")

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
