import json
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from agent import webui


class LevelSizeEndpointTests(unittest.TestCase):
    def _server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), webui.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server, f"http://127.0.0.1:{server.server_address[1]}"

    def _post(self, base, path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            return urllib.request.urlopen(req, timeout=5).status
        except urllib.error.HTTPError as err:
            return err.code

    def test_levelsize_sets_state_and_appears_in_snapshot(self):
        server, base = self._server()
        try:
            self.assertEqual(self._post(base, "/api/levelsize", {"size": "small"}), 200)
            state = json.loads(urllib.request.urlopen(base + "/api/state", timeout=5).read())
            self.assertEqual(state["level_size"], "small")
            # invalid size is rejected and does not change the stored value
            self.assertEqual(self._post(base, "/api/levelsize", {"size": "huge"}), 400)
            state = json.loads(urllib.request.urlopen(base + "/api/state", timeout=5).read())
            self.assertEqual(state["level_size"], "small")
        finally:
            server.shutdown()
            with webui._lock:
                webui._state["level_size"] = "medium"   # restore default for other tests


class TraceTelemetryTests(unittest.TestCase):
    def test_entity_workshop_exposes_roster_save_control(self):
        html = (Path(webui.__file__).parent / "entity" / "web" / "index.html").read_text(
            encoding="utf-8"
        )
        self.assertIn('id="save"', html)
        self.assertIn('fetch("/api/save"', html)

    def test_trace_is_normalized_and_invalid_samples_are_dropped(self):
        trace = webui._sanitize_trace([
            {"x": 10.26, "y": 20, "t_ms": 750.4},
            {"x": True, "y": 20, "t_ms": 1500},
            {"x": 30, "y": "bad", "t_ms": 2250},
            {"x": 40, "y": 50, "t_ms": -5},
        ])
        self.assertEqual(trace, [
            {"x": 10.3, "y": 20.0, "t_ms": 750},
            {"x": 40.0, "y": 50.0, "t_ms": 0},
        ])

    def test_trace_is_capped(self):
        raw = [{"x": index, "y": 1, "t_ms": index * 750} for index in range(5000)]
        self.assertEqual(len(webui._sanitize_trace(raw)), 4800)


if __name__ == "__main__":
    unittest.main()
