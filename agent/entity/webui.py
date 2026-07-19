"""Standalone browser workshop for authoring enemies and bosses.

Standard-library HTTP server on its own port so it can run alongside the main
design dashboard. Same NVIDIA Nemotron setup via ``agent.llm``.

    AGENT_MOCK=1 python -m agent.entity.webui   # then open http://localhost:8788
    NVIDIA_API_KEY=... python -m agent.entity.webui

Endpoints:
    GET  /                index.html
    GET  /api/status      backend/mode + recent LLM traffic
    POST /api/generate    {"description": str} -> spec + validation + tokens
    POST /api/save        {"spec": EntitySpec} -> append to main enemy roster
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .. import enemy_designer, llm
from . import generator

PORT = 8788
ENTITY_DIR = Path(__file__).parent
INDEX_HTML = ENTITY_DIR / "web" / "index.html"
ENTITY_RUNTIME_JS = ENTITY_DIR.parent / "web" / "entity_runtime.js"

# Serialize generation: one shared token budget / LLM queue underneath.
_gen_lock = threading.Lock()
_save_lock = threading.Lock()


def _status() -> dict:
    return {
        "mode": "mock" if generator._use_mock() else "llm",
        "backend": llm.backend(),
        "model": generator.MODEL,
        "tokens": llm.cycle_usage(),
        "llm_queue": llm.queue_status(),
        "llm_log": llm.read_log(20),
        "roster_count": len(enemy_designer.load_roster()),
        "roster_max": enemy_designer.MAX_ARCHETYPES,
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send(200, INDEX_HTML.read_bytes(), "text/html; charset=utf-8")
        elif self.path == "/entity_runtime.js":
            self._send(200, ENTITY_RUNTIME_JS.read_bytes(), "text/javascript; charset=utf-8")
        elif self.path == "/api/status":
            self._send(200, _status())
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/api/generate":
            body = self._body()
            description = str(body.get("description", ""))[:2000]
            if not _gen_lock.acquire(blocking=False):
                self._send(409, {"error": "already generating — one at a time"})
                return
            try:
                result = generator.generate(description)
            except Exception as err:  # never leave the socket hanging
                result = {"spec": None, "validation": None, "error": str(err)}
            finally:
                _gen_lock.release()
            self._send(200, result)
        elif self.path == "/api/save":
            body = self._body()
            try:
                with _save_lock:
                    saved = enemy_designer.save_entityspec(body.get("spec"), "workshop")
            except FileExistsError as err:
                self._send(409, {"error": str(err)})
                return
            except ValueError as err:
                self._send(422, {"error": str(err)})
                return
            self._send(201, saved)
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *args):  # silence per-request stderr noise
        pass


def main():
    ThreadingHTTPServer.request_queue_size = 32
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    mode = "mock" if generator._use_mock() else "llm"
    print(f"entity workshop running at http://localhost:{PORT}  (mode: {mode})")
    server.serve_forever()


if __name__ == "__main__":
    main()
