from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

UPSTREAM_FRONTEND = "http://127.0.0.1:5173"
UPSTREAM_BRIDGE = "http://127.0.0.1:8765"


def upstream_for_path(path: str) -> str:
    if path.startswith("/bridge/") or path == "/bridge":
        return UPSTREAM_BRIDGE + path[len("/bridge"):]
    return UPSTREAM_FRONTEND + path

class Proxy(BaseHTTPRequestHandler):
    def _proxy(self):
        content_length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(content_length) if content_length else None
        url = upstream_for_path(self.path)
        headers = {k: v for k, v in self.headers.items() if k.lower() != "host"}

        response = requests.request(
            method=self.command,
            url=url,
            headers=headers,
            data=body,
            allow_redirects=False,
            stream=True,
        )

        self.send_response(response.status_code)
        for key, value in response.headers.items():
            if key.lower() in {
                "content-length",
                "transfer-encoding",
                "connection",
                "keep-alive",
                "proxy-authenticate",
                "proxy-authorization",
                "te",
                "trailers",
                "upgrade",
            }:
                continue
            self.send_header(key, value)
        self.end_headers()
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if chunk:
                self.wfile.write(chunk)

    def do_GET(self):
        self._proxy()

    def do_HEAD(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def do_PUT(self):
        self._proxy()

    def do_PATCH(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def do_OPTIONS(self):
        self._proxy()


ThreadingHTTPServer(("", 5000), Proxy).serve_forever()
