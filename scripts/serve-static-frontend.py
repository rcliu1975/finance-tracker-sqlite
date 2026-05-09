#!/usr/bin/env python3
from __future__ import annotations

import argparse
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


EXACT_PUBLIC_FILES = {
    "index.html",
    "styles.css",
    "app.js",
    "favicon.svg",
    "app-config.js",
    "firebase-config.js",
}


def parse_args() -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent
    parser = argparse.ArgumentParser(description="Serve only the frontend files required by finance-tracker-sqlite.")
    parser.add_argument("--root", default=str(repo_root), help="Repository root that contains index.html.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=5173, help="Bind port. Default: 5173")
    parser.add_argument(
        "--allow-file",
        action="append",
        default=[],
        help="Extra root-relative file to serve. Repeat for multiple files.",
    )
    return parser.parse_args()


def normalize_relative_path(raw_path: str) -> str:
    path = unquote(urlparse(raw_path).path)
    if path == "/":
        return "index.html"
    if not path.startswith("/"):
        return ""
    relative = path.lstrip("/")
    if "\\" in relative:
        return ""
    parts = relative.split("/")
    if any(part in {"", ".", ".."} or part.startswith(".") for part in parts):
        return ""
    return relative


def is_allowed_frontend_file(relative_path: str, extra_files: set[str]) -> bool:
    if relative_path in EXACT_PUBLIC_FILES or relative_path in extra_files:
        return True
    return relative_path.startswith("data/") and relative_path.endswith(".js")


class FrontendHandler(BaseHTTPRequestHandler):
    server_version = "FinanceTrackerStatic/1.0"

    def do_GET(self):
        self.serve_file(send_body=True)

    def do_HEAD(self):
        self.serve_file(send_body=False)

    def serve_file(self, send_body: bool) -> None:
        relative_path = normalize_relative_path(self.path)
        if not relative_path or not is_allowed_frontend_file(relative_path, self.server.extra_files):
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        file_path = (self.server.root_path / relative_path).resolve()
        try:
            file_path.relative_to(self.server.root_path)
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        if not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_security_headers(relative_path)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def send_security_headers(self, relative_path: str) -> None:
        cache_control = "no-store" if relative_path in {"app-config.js", "firebase-config.js"} else "public, max-age=300"
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")

    def log_message(self, format: str, *args):
        return


def main() -> int:
    args = parse_args()
    root_path = Path(args.root).expanduser().resolve()
    extra_files = {normalize_relative_path(f"/{value}") for value in args.allow_file}
    extra_files.discard("")

    server = ThreadingHTTPServer((args.host, args.port), FrontendHandler)
    server.root_path = root_path
    server.extra_files = extra_files
    print(f"Frontend static server listening on http://{args.host}:{args.port} root={root_path}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
