"""Browser dashboard for the game-design agent.

Standard-library HTTP server: serves web/index.html plus a small JSON API.

    python3 -m agent.webui            # then open http://localhost:8777
    AGENT_MOCK=1 python3 -m agent.webui

Endpoints:
    GET  /api/state      full snapshot: levels (CSV), rounds, lessons, library, log
    GET  /api/playlevel  newest CSV level for the in-browser game
    POST /api/feedback   playtest result -> writes feedback.json -> runs the
                         agent cycle in a background thread -> next level
    POST /api/reset      wipe generated data back to level_000
"""

import contextlib
import json
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import llm, pipeline, store

PORT = 8777
AGENT_DIR = Path(__file__).parent
DATA_DIR = AGENT_DIR / "data"
LEVELS_DIR = DATA_DIR / "levels"
ROUNDS_DIR = DATA_DIR / "rounds"
INDEX_HTML = AGENT_DIR / "web" / "index.html"
ENTITY_RUNTIME_JS = AGENT_DIR / "web" / "entity_runtime.js"

_state = {"running": False, "log": [], "error": None, "mode": "adventure"}
_lock = threading.Lock()


class _LogWriter:
    """File-like object that appends completed lines to the shared log."""

    def __init__(self):
        self._buf = ""

    def write(self, text):
        self._buf += text
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.strip():
                with _lock:
                    _state["log"].append(line)

    def flush(self):
        pass


def _run_agent_cycle(round_number: int, level_path: Path,
                     mode: str = "adventure", feedback: dict | None = None):
    try:
        with contextlib.redirect_stdout(_LogWriter()):
            if mode == "battle":
                from . import battle
                battle.run_battle_cycle(round_number, feedback)
            else:
                pipeline.run_cycle(round_number, level_path)
    except Exception as err:  # surface failures in the UI instead of a dead thread
        with _lock:
            _state["error"] = str(err)
            _state["log"].append(f"ERROR: {err}")
    finally:
        with _lock:
            _state["running"] = False


def _sanitize_trace(raw_trace) -> list[dict]:
    """Bound and normalize browser telemetry before persisting or prompting."""
    trace = []
    if not isinstance(raw_trace, list):
        return trace
    for sample in raw_trace[:4800]:  # one hour at 750 ms plus headroom
        if not isinstance(sample, dict):
            continue
        x, y, t_ms = sample.get("x"), sample.get("y"), sample.get("t_ms")
        if any(isinstance(value, bool) or not isinstance(value, (int, float))
               for value in (x, y, t_ms)):
            continue
        trace.append({
            "x": round(float(x), 1), "y": round(float(y), 1),
            "t_ms": max(0, round(float(t_ms))),
        })
    return trace


def _handle_feedback(body: dict) -> tuple[int, dict]:
    rating = body.get("rating")
    if not isinstance(rating, int) or not 1 <= rating <= 5:
        return 400, {"error": "rating must be an integer 1-5"}
    with _lock:
        if _state["running"]:
            return 409, {"error": "agent is already designing — wait for the next level"}
        _state["running"] = True
        _state["error"] = None

    level_path = pipeline.latest_level()
    round_number = int(level_path.stem.split("_")[1]) + 1
    trace = _sanitize_trace(body.get("player_trace", []))

    feedback = {
        "round": round_number,
        "level": level_path.stem,
        "players": [{
            "player": body.get("player", "playtester"),
            "rating": rating,
            "completed": bool(body.get("completed", False)),
            "deaths": int(body.get("falls", 0)),
            "fall_locations": body.get("fall_locations", []),
            "time_seconds": round(float(body.get("time_seconds", 0)), 1),
            "enemies_killed": int(body.get("kills", 0)),
            "hits_taken": int(body.get("hits_taken", 0)),
            "objects_collected": int(body.get("objects_collected", 0)),
            "player_trace": trace,
            "comment": str(body.get("comment", ""))[:500],
        }],
    }
    round_dir = ROUNDS_DIR / f"round_{round_number:03d}"
    round_dir.mkdir(parents=True, exist_ok=True)
    (round_dir / "feedback.json").write_text(json.dumps(feedback, indent=2))
    with _lock:
        p = feedback["players"][0]
        _state["log"].append(
            f"=== ROUND {round_number}: playtest of {level_path.stem} — "
            f"{p['rating']}/5, {p['deaths']} falls, {p['time_seconds']}s, "
            f"{len(p['player_trace'])} position samples — \"{p['comment']}\""
        )
    with _lock:
        mode = _state.get("mode", "adventure")
    threading.Thread(target=_run_agent_cycle,
                     args=(round_number, level_path, mode, feedback), daemon=True).start()
    return 200, {"ok": True, "round": round_number, "mode": mode}


def _handle_mode(body: dict) -> tuple[int, dict]:
    """Switch game mode. Entering battle generates an initial arena immediately so
    the player can start fighting without first rating an adventure level."""
    mode = body.get("mode")
    if mode not in ("adventure", "battle"):
        return 400, {"error": "mode must be 'adventure' or 'battle'"}
    with _lock:
        _state["mode"] = mode
    if mode != "battle":
        return 200, {"ok": True, "mode": mode}
    with _lock:
        if _state["running"]:
            return 200, {"ok": True, "mode": mode, "note": "agent busy; arena will follow"}
        _state["running"] = True
        _state["error"] = None
    level_path = pipeline.latest_level()
    round_number = int(level_path.stem.split("_")[1]) + 1
    threading.Thread(target=_run_agent_cycle,
                     args=(round_number, level_path, "battle", None), daemon=True).start()
    return 200, {"ok": True, "mode": mode, "round": round_number}


def _reset():
    for f in LEVELS_DIR.glob("level_*"):
        if f.stem != "level_000" or f.suffix != ".csv":
            f.unlink()
    (LEVELS_DIR / "next_level.ready").unlink(missing_ok=True)
    (DATA_DIR / "battle_state.json").unlink(missing_ok=True)  # difficulty back to base
    (DATA_DIR / "battle_enemies.json").write_text("[]\n")     # battle bestiary back to empty
    shutil.rmtree(ROUNDS_DIR, ignore_errors=True)
    shutil.rmtree(DATA_DIR / "store", ignore_errors=True)
    shutil.rmtree(DATA_DIR / "library", ignore_errors=True)
    llm.clear_log()
    with _lock:
        _state["log"].clear()
        _state["error"] = None


def _snapshot() -> dict:
    levels = {f.stem: f.read_text() for f in sorted(LEVELS_DIR.glob("level_*.csv"))}
    rounds = {}
    if ROUNDS_DIR.exists():
        for d in sorted(ROUNDS_DIR.glob("round_*")):
            entry = {}
            for name in ("feedback", "analysis", "object_design", "enemy_design", "battle_design"):
                p = d / f"{name}.json"
                if p.exists():
                    entry[name] = json.loads(p.read_text())
            rounds[int(d.name.split("_")[1])] = entry
    with _lock:
        running, log, error = _state["running"], list(_state["log"]), _state["error"]
        game_mode = _state.get("mode", "adventure")
    from . import object_designer
    return {
        "mode": "mock" if pipeline._use_mock() else "llm",
        "game_mode": game_mode,
        "backend": llm.backend(),
        "tokens": llm.cycle_usage(),
        "llm_queue": llm.queue_status(),
        "running": running,
        "error": error,
        "log": log[-200:],
        "levels": levels,
        "rounds": rounds,
        "lessons": store.load_lessons(),
        "object_lessons": object_designer.load_lessons(),
        "memory": store.memory_status(),
        "library": store.library_summary(),
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
        elif self.path == "/api/state":
            self._send(200, _snapshot())
        elif self.path == "/api/llmlog":
            self._send(200, {"entries": llm.read_log(100)})
        elif self.path.split("?")[0] == "/api/enemies":
            from urllib.parse import parse_qs, urlsplit
            from . import battle, enemy_designer
            mode = (parse_qs(urlsplit(self.path).query).get("mode", ["adventure"])[0])
            target = enemy_designer.BATTLE if mode == "battle" else enemy_designer.ADVENTURE
            roster = enemy_designer.load_roster(target)
            enemies = [{**e, "threat": round(battle.difficulty_score(e), 2)}
                       for e in roster if isinstance(e, dict)]
            self._send(200, {"enemies": enemies})
        elif self.path == "/api/objects":
            from . import object_designer
            self._send(200, {"objects": object_designer.load_catalog()})
        elif self.path == "/api/playlevel":
            csvs = sorted(LEVELS_DIR.glob("level_*.csv"))
            if not csvs:
                self._send(404, {"error": "no CSV level found"})
            else:
                self._send(200, {"name": csvs[-1].stem, "csv": csvs[-1].read_text()})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/api/feedback":
            code, resp = _handle_feedback(self._body())
            self._send(code, resp)
        elif self.path == "/api/mode":
            code, resp = _handle_mode(self._body())
            self._send(code, resp)
        elif self.path == "/api/reset":
            with _lock:
                if _state["running"]:
                    self._send(409, {"error": "cannot reset while the agent is designing"})
                    return
            _reset()
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *args):  # silence per-request stderr noise
        pass


def main():
    ThreadingHTTPServer.request_queue_size = 32  # default backlog of 5 can drop bursts of polls
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    mode = "mock" if pipeline._use_mock() else "llm"
    print(f"agent dashboard running at http://localhost:{PORT}  (mode: {mode})")
    server.serve_forever()


if __name__ == "__main__":
    main()
