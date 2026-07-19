"""Battle mode: a fixed single-screen arena that is purely about fighting.

Instead of the Level Designer, a mechanical difficulty controller drives a small
Battle agent. Each round the controller ratchets a difficulty target ``D`` from the
last playtest, decides *when* to buff/create enemies (via the Enemy Designer), and
the Battle agent (LLM, with a deterministic mock/heuristic fallback) picks *which*
roster enemies to field. Picks are stamped into a fixed arena template at predefined
spawn slots and written as the next ``level_NNN.csv`` — so the existing level
serving + ``spawnEnemies`` path runs battles with no change (Phase 1: all-at-once).
"""

import copy
import datetime
import json
from pathlib import Path

from . import csv_level, enemy_designer, llm, pipeline

DATA_DIR = Path(__file__).parent / "data"
LEVELS_DIR = DATA_DIR / "levels"
ROUNDS_DIR = DATA_DIR / "rounds"
STATE_PATH = DATA_DIR / "battle_state.json"

BASE_D = 1.0                 # starting difficulty target
BUFF_MARGIN = 0.5            # raise the ceiling when D exceeds the top enemy by this much
CREATE_EVERY = 4            # create a new archetype at most every N rounds
MAX_PICKS = 6               # cap enemies fielded per battle (bounded by arena slots)

# Fixed 30x30-wide, 15-row arena => 960x480 at TILE=32, so the camera centers and
# does NOT scroll (index.html centers levels <= viewport). Three platform elevations
# plus a solid floor; S/E kept valid so csv_level.validate_text passes (Battle mode
# wins by kill-all and ignores the exit).
ARENA_ROWS, ARENA_COLS = 15, 30
_FLOOR_ROW = 14
_PLATFORMS = (            # (row, col_start, col_end) inclusive — three elevations
    (11, 6, 12), (11, 18, 24),   # low
    (8, 3, 9), (8, 20, 26),      # mid
    (5, 12, 17),                 # high
)
_SPAWN = (2, 13)          # (col, row) player spawn on the floor
_EXIT = (27, 13)          # (col, row) nominal exit (unused by battle win, needed to validate)
# Enemy spawn slots (col, row), priority order: single pick -> slot 0, swarm spreads out.
# Each slot cell is open with solid support directly below (floor or a platform).
_SLOTS = (
    (15, 13),   # floor center
    (9, 10),    # low-left platform top
    (21, 10),   # low-right platform top
    (6, 7),     # mid-left platform top
    (23, 7),    # mid-right platform top
    (15, 4),    # high-center platform top
    (9, 13),    # floor left
    (21, 13),   # floor right
)

SYSTEM = """You are the Battle agent for a self-improving 2D platformer's Battle mode.
Each round the player fights enemies in a fixed arena. You choose WHICH enemies to field
this round to hit a difficulty target D (higher = harder). You do not tune enemy stats and
you do not place them — you only pick ids from the roster.

Return ONLY this JSON shape:
{ "note": "one sentence on the encounter you chose", "picks": ["enemyId", ...] }

Rules:
- Pick 1 to 6 enemy ids that exist in the roster. Repeat an id to spawn multiple copies.
- Match the total threat to D: one strong enemy near D, or several weaker enemies that add up.
- Prefer escalating and varying the encounter versus the previous round; do not always pick the same enemy.
- Never invent ids. Return only ids present in the provided roster."""


# --------------------------------------------------------------------------- state

def _load_state() -> dict:
    if STATE_PATH.exists():
        try:
            data = json.loads(STATE_PATH.read_text())
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, OSError):
            pass
    return {"D": BASE_D, "round": 0, "last_create_round": -CREATE_EVERY, "history": []}


def _save_state(state: dict):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------- difficulty

def _num(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def difficulty_score(enemy: dict) -> float:
    """Heuristic threat rating for one enemy. Higher = harder. Tunable."""
    if not isinstance(enemy, dict):
        return 1.0
    if enemy_designer.is_entity_spec(enemy):
        root = enemy.get("root", {}) if isinstance(enemy.get("root"), dict) else {}
        health = _num((root.get("health") or {}).get("max"), 10)
        contact = _num((root.get("contact") or {}).get("damage"), 1)
        motion = _num((root.get("motion") or {}).get("speed"), 3)
        max_alive = _num((enemy.get("limits") or {}).get("maxAlive"), 1)
        # EntitySpec enemies are inherently more complex/boss-like.
        return 3.0 + health / 40 + contact * 1.5 + motion * 0.4 + max_alive * 0.4
    parts = enemy.get("parts", []) if isinstance(enemy.get("parts"), list) else []
    hp = sum(_num(p.get("hp")) for p in parts if isinstance(p, dict) and p.get("vulnerable"))
    attack = enemy.get("attack", {}) if isinstance(enemy.get("attack"), dict) else {}
    if attack.get("type", "none") != "none":
        ranged = (_num(attack.get("damage"), 1) * 1.5 + _num(attack.get("range")) / 300
                  + _num(attack.get("speed")) * 0.2 + 2.0 / max(_num(attack.get("cooldown_s"), 2), 0.3))
    else:
        ranged = 0.0
    contact = _num(enemy.get("contact_damage"), 1)
    move = enemy.get("movement", {}) if isinstance(enemy.get("movement"), dict) else {}
    return hp / 25 + ranged + contact + _num(move.get("speed")) / 60


def _update_difficulty(prev_d: float, feedback: dict) -> float:
    """Ratchet the difficulty target from the last battle's outcome."""
    player = (feedback.get("players") or [{}])[0]
    completed = bool(player.get("completed"))
    deaths = _num(player.get("deaths"))
    hits = _num(player.get("hits_taken"))
    time_s = _num(player.get("time_seconds"))
    d = prev_d
    if completed and deaths == 0 and hits <= 1 and 0 < time_s < 20:
        d += 1.0        # trivial win -> push hard
    elif completed and deaths == 0:
        d += 0.5        # clean but took effort
    elif completed:
        d += 0.25       # scraped through
    elif deaths >= 3:
        d -= 0.5        # too hard -> ease off
    return max(1.0, round(d, 2))


# -------------------------------------------------------------------------- arena

def _blank_arena() -> list[list[str]]:
    grid = [["."] * ARENA_COLS for _ in range(ARENA_ROWS)]
    for c in range(ARENA_COLS):
        grid[_FLOOR_ROW][c] = "X"
    for row, c0, c1 in _PLATFORMS:
        for c in range(c0, c1 + 1):
            grid[row][c] = "X"
    grid[_SPAWN[1]][_SPAWN[0]] = "S"
    grid[_EXIT[1]][_EXIT[0]] = "E"
    return grid


def _stamp_arena(picks: list[str], roster: list[dict]) -> str:
    """Place each picked enemy id into the next free arena slot as its CSV digit."""
    id_to_digit = {e.get("id"): i + 1 for i, e in enumerate(roster) if isinstance(e, dict)}
    grid = _blank_arena()
    placed_boss = set()
    slot = 0
    for pid in picks:
        digit = id_to_digit.get(pid)
        if digit is None or slot >= len(_SLOTS):
            continue
        enemy = roster[digit - 1]
        is_boss = enemy_designer.is_entity_spec(enemy) and enemy.get("kind") == "boss"
        if is_boss:
            if pid in placed_boss:
                continue  # a boss spawns once; multiple copies collapse in the engine
            placed_boss.add(pid)
        col, row = _SLOTS[slot]
        grid[row][col] = str(digit)
        slot += 1
    return csv_level.serialize(grid)


# --------------------------------------------------------------------------- picks

def _heuristic_pick(roster: list[dict], scores: dict, target_d: float) -> list[str]:
    """Deterministic composition ~ target_d. Used in mock mode and as LLM fallback."""
    if not roster:
        return []
    ids = [e["id"] for e in roster if isinstance(e, dict) and e.get("id")]
    closest = min(ids, key=lambda i: abs(scores[i] - target_d))
    if scores[closest] >= target_d * 0.8:
        return [closest]                      # one enemy already matches the target
    ranked = sorted(ids, key=lambda i: scores[i])   # weakest first, build a swarm
    picks, total, idx = [], 0.0, 0
    while total < target_d and len(picks) < MAX_PICKS:
        pid = ranked[min(idx, len(ranked) - 1)]
        picks.append(pid)
        total += max(scores[pid], 0.1)
        idx += 1
    return picks or [closest]


def _llm_pick(roster: list[dict], scores: dict, target_d: float,
              feedback: dict) -> tuple[list[str], str]:
    summary = [{"id": e["id"], "name": e.get("name", e["id"]),
                "score": round(scores[e["id"]], 2), "desc": e.get("desc", "")[:120]}
               for e in roster if isinstance(e, dict) and e.get("id")]
    player = (feedback.get("players") or [{}])[0]
    user = (
        f"DIFFICULTY TARGET D = {target_d}\n\n"
        f"ROSTER (id, name, threat score, desc):\n{json.dumps(summary, indent=2)}\n\n"
        f"LAST BATTLE: completed {player.get('completed', False)}, "
        f"killed {player.get('enemies_killed', 0)}, hits taken {player.get('hits_taken', 0)}, "
        f"deaths {player.get('deaths', 0)}, time {player.get('time_seconds', '?')}s, "
        f"comment: {player.get('comment', '')!r}\n\n"
        "Choose the enemies to field this round so the total threat is close to D."
    )
    result = llm.complete_json(SYSTEM, user, model=llm.DESIGNER_MODEL,
                               max_tokens=600, label="battle designer")
    picks = result.get("picks") if isinstance(result, dict) else None
    valid = {e["id"] for e in roster if isinstance(e, dict) and e.get("id")}
    picks = [p for p in picks if p in valid][:MAX_PICKS] if isinstance(picks, list) else []
    return (picks, result.get("note", "") if isinstance(result, dict) else "")


def _should_create(state: dict, feedback: dict, roster: list[dict]) -> bool:
    if len(roster) >= enemy_designer.MAX_ARCHETYPES:
        return False
    round_number = state.get("round", 0)
    if round_number - state.get("last_create_round", -CREATE_EVERY) >= CREATE_EVERY:
        return True
    comment = str((feedback.get("players") or [{}])[0].get("comment", "")).lower()
    if any(k in comment for k in enemy_designer.NEW_ARCHETYPE_KEYWORDS):
        return True
    # Homogeneous roster (all legacy with the same movement type) -> add variety.
    move_types = {e.get("movement", {}).get("type") for e in roster
                  if isinstance(e, dict) and not enemy_designer.is_entity_spec(e)}
    return len(roster) >= 3 and len(move_types) <= 1


# ------------------------------------------------------------------------- cycle

def run_battle_cycle(round_number: int, prev_feedback: dict | None = None) -> Path | None:
    """Produce the next battle arena `level_NNN.csv`. Returns its path, or None when
    the battle bestiary is empty (nothing to field yet).

    `prev_feedback` is the just-played battle's feedback (None for the very first
    arena, e.g. when the player switches into Battle mode)."""
    mock = pipeline._use_mock()
    state = _load_state()
    state["round"] = round_number
    roster = enemy_designer.load_roster(enemy_designer.BATTLE)
    if not roster:
        # The battle bestiary starts empty and is populated by the enemy workshop
        # (import into both bestiaries) or battle's own create lever. Until it has
        # at least one enemy there is nothing to field — surface a clear message
        # to the dashboard log and skip generation rather than crashing the cycle.
        print("[battle] bestiary empty — design and import enemies from the workshop "
              "before starting a battle")
        return None

    if prev_feedback:
        state["D"] = _update_difficulty(state.get("D", BASE_D), prev_feedback)
    d = state.get("D", BASE_D)
    feedback = prev_feedback or {"players": [{}]}
    print(f"[battle round {round_number}] difficulty target D={d} ({'mock' if mock else 'llm'})")

    buffed = created = None
    scores = {e["id"]: difficulty_score(e) for e in roster if isinstance(e, dict) and e.get("id")}

    # LLM-only levers: raise the ceiling when nothing in the roster is hard enough,
    # and occasionally introduce a brand-new archetype for variety.
    if not mock and scores:
        top_id = max(scores, key=scores.get)
        if scores[top_id] < d - BUFF_MARGIN:
            print(f"  roster ceiling {scores[top_id]:.2f} < target {d}; hardening '{top_id}'")
            try:
                if enemy_designer.harden_and_write(top_id, feedback, round_number,
                                                   target=enemy_designer.BATTLE):
                    buffed = top_id
                    roster = enemy_designer.load_roster(enemy_designer.BATTLE)
                    scores = {e["id"]: difficulty_score(e) for e in roster
                              if isinstance(e, dict) and e.get("id")}
            except Exception as err:
                print(f"  enemy hardening skipped after error: {err}")

        if _should_create(state, feedback, roster):
            print("  requesting a new battle archetype (enemy designer)...")
            try:
                analysis = {"diagnosis": f"Battle mode round {round_number} wants a new enemy "
                            f"archetype for variety at difficulty {d}."}
                record = enemy_designer.maybe_add_entityspec(analysis, feedback, round_number,
                                                             target=enemy_designer.BATTLE)
                if record:
                    created = record.get("entity_id") or record.get("name")
                    state["last_create_round"] = round_number
                    roster = enemy_designer.load_roster(enemy_designer.BATTLE)
                    scores = {e["id"]: difficulty_score(e) for e in roster
                              if isinstance(e, dict) and e.get("id")}
            except Exception as err:
                print(f"  new-archetype creation skipped after error: {err}")

    # Pick the encounter (LLM when available, deterministic heuristic otherwise).
    note = ""
    if mock:
        picks = _heuristic_pick(roster, scores, d)
    else:
        try:
            picks, note = _llm_pick(roster, scores, d, feedback)
        except Exception as err:
            print(f"  battle designer LLM pick failed ({err}); using heuristic")
            picks = []
        if not picks:
            picks = _heuristic_pick(roster, scores, d)
    if not picks:
        raise RuntimeError("battle designer produced no valid enemy picks")
    print(f"  battle picks: {picks}")

    arena_csv = _stamp_arena(picks, roster)
    errors = csv_level.validate_text(arena_csv)
    if errors:
        raise RuntimeError(f"battle arena failed validation: {errors}")

    next_path = LEVELS_DIR / f"level_{round_number:03d}.csv"
    next_path.parent.mkdir(parents=True, exist_ok=True)
    next_path.write_text(arena_csv)
    (LEVELS_DIR / "next_level.ready").write_text(next_path.name)

    design = {"round": round_number, "mode": "battle", "difficulty": d,
              "picks": picks, "note": note, "buffed": buffed, "created": created,
              "scores": {k: round(v, 2) for k, v in scores.items()}}
    round_dir = ROUNDS_DIR / f"round_{round_number:03d}"
    round_dir.mkdir(parents=True, exist_ok=True)
    (round_dir / "battle_design.json").write_text(json.dumps(design, indent=2))

    state.setdefault("history", []).append({
        "round": round_number, "D": d, "picks": picks,
        "buffed": buffed, "created": created,
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
    })
    _save_state(state)
    print(f"  wrote {next_path.name} (battle arena, D={d})")
    return next_path
