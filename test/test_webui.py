import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from agent import enemy_designer, webui


class TraceTelemetryTests(unittest.TestCase):
    def test_entity_workshop_exposes_roster_save_control(self):
        html = (Path(webui.__file__).parent / "entity" / "web" / "index.html").read_text(
            encoding="utf-8"
        )
        self.assertIn('id="save"', html)
        self.assertIn('fetch("/api/save"', html)

    def test_reset_empties_battle_bestiary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            levels = root / "levels"
            levels.mkdir()
            (levels / "level_000.csv").write_text("S.E")
            battle_roster = root / "battle_enemies.json"
            battle_roster.write_text(json.dumps([{"id": "x", "name": "X"}]))
            with mock.patch.object(webui, "DATA_DIR", root), \
                 mock.patch.object(webui, "LEVELS_DIR", levels), \
                 mock.patch.object(webui, "ROUNDS_DIR", root / "rounds"), \
                 mock.patch.object(webui.llm, "clear_log"):
                webui._reset()
            self.assertEqual(json.loads(battle_roster.read_text()), [])

    def test_api_enemies_battle_mode_returns_threat(self):
        with tempfile.TemporaryDirectory() as directory:
            battle_roster = Path(directory) / "battle_enemies.json"
            battle_roster.write_text(json.dumps([{
                "id": "grub", "name": "Grub",
                "parts": [{"vulnerable": True, "hp": 30}],
                "attack": {"type": "none"}, "contact_damage": 1,
                "movement": {"type": "patrol", "speed": 40},
            }]))
            with mock.patch.object(enemy_designer, "BATTLE_ROSTER_PATH", battle_roster):
                server = ThreadingHTTPServer(("127.0.0.1", 0), webui.Handler)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                try:
                    url = f"http://127.0.0.1:{server.server_address[1]}/api/enemies?mode=battle"
                    payload = json.loads(urllib.request.urlopen(url, timeout=5).read())
                finally:
                    server.shutdown()
        self.assertEqual(len(payload["enemies"]), 1)
        self.assertEqual(payload["enemies"][0]["name"], "Grub")
        self.assertIsInstance(payload["enemies"][0]["threat"], (int, float))

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
