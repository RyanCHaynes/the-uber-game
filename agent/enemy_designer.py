"""Nemotron-powered enemy designer: adapts the enemy roster between rounds.

Owns *what each enemy is* and evolves it from playtest feedback via small,
validated patches against the shipped ``enemies.json`` schema. The Level Designer
still owns placement (by digit); this role never places enemies and never writes
code. Structured as a sibling of ``object_designer.py``.

Phase 1 slice: the adapt-existing loop only (``adapt`` -> ``apply_patch`` ->
``validate_roster`` -> rollback-safe write). New-archetype ``propose`` and the
role-lesson failure loop are deliberately left for a later slice.
"""

import copy
import datetime
import json
import re
from pathlib import Path

from . import llm

DATA_DIR = Path(__file__).parent / "data"
ROSTER_PATH = DATA_DIR / "enemies.json"
LAST_GOOD_PATH = DATA_DIR / "store" / "enemies_last_good.json"
DESIGN_LOG_PATH = DATA_DIR / "store" / "enemy_design_log.jsonl"

MAX_ARCHETYPES = 9      # CSV digit ceiling (1-9); array index + 1 is the digit
MAX_OPS = 12            # change budget: at most this many tweaks per round
MAX_ADAPT_ATTEMPTS = 3

MOVEMENT_TYPES = {"patrol", "stationary", "flyer"}
ATTACK_TYPES = {"none", "lob", "shoot"}
PART_SHAPES = {"rect", "circle", "tri"}

# Combat-signal detection: only adapt when feedback plausibly implicates enemies.
ENEMY_KEYWORDS = (
    "enemy", "enemies", "grub", "turret", "wasp", "shoot", "shot", "stinger",
    "bomb", "hit", "damage", "kill", "attack", "flyer", "fly", "bullet", "hurt",
)

SYSTEM = """You are the Enemy Designer for a self-improving 2D platformer. You own
what each enemy IS and tune it between rounds from playtest feedback. You never place
enemies in levels (the Level Designer does that) and you never write code.

Adapt the existing roster by emitting a small PATCH of numeric tweaks against stable
ids. Return ONLY this JSON shape:
{
  "note": "one sentence: what you changed and why",
  "ops": [ ["set" | "add" | "mul", "<enemyId>.<dot.path>", <number>] ]
}

Path rules:
- Target enemies and parts by their stable "id", never by array index.
- A part field is "<enemyId>.parts.<partId>.<field>", e.g. "wasp.parts.body.hp".
- Only edit numeric fields that already exist. Tunable fields:
  movement.speed, movement.range, movement.bob, movement.bob_hz,
  attack.cooldown_s, attack.speed, attack.damage, attack.range, attack.gravity,
  contact_damage, and per-part hp / w / h / r / offset.x / offset.y.
- "set" replaces, "add" adds a delta, "mul" multiplies. Values are numbers only.

Rules:
- Do NOT add or remove enemies or parts, rename ids, or change any movement/attack "type".
- Keep it surgical: small deltas, few ops. Make enemies fairer, not trivial.
- If the feedback does not clearly implicate an enemy, return {"note":"...","ops":[]}."""


def load_roster() -> list[dict]:
    if not ROSTER_PATH.exists():
        return []
    try:
        data = json.loads(ROSTER_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def roster_summary() -> str:
    """Digit -> type summary, matching the format the Level Designer already reads."""
    roster = load_roster()
    if not roster:
        return ""
    return "\n".join(
        f"{i + 1}: {e['name']} — {e.get('desc', '')}" for i, e in enumerate(roster)
    )


def _is_hex_color(value) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"#[0-9a-fA-F]{6}", value))


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _clamp(value, low: float, high: float, default: float):
    """Clamp to a safe range, preserving integer-ness for clean JSON."""
    try:
        num = min(high, max(low, float(value)))
    except (TypeError, ValueError):
        return default
    return int(num) if num == int(num) else round(num, 2)


# Per-enemy numeric safety ranges. Applied after a patch so small model drift is
# clamped rather than rejected; validate_roster still rejects structural damage.
_MOVEMENT_RANGES = {
    "speed": (0, 200, 45), "range": (0, 600, 96),
    "bob": (0, 120, 0), "bob_hz": (0, 4, 0),
}
_ATTACK_RANGES = {
    "cooldown_s": (0.3, 10, 1.8), "speed": (0.5, 20, 4.5),
    "damage": (0, 5, 1), "range": (0, 1200, 380), "gravity": (0, 2, 0),
}


def _sanitize_enemy(enemy: dict):
    """Clamp every tunable numeric field of one enemy in place."""
    if _is_number(enemy.get("contact_damage")):
        enemy["contact_damage"] = int(_clamp(enemy["contact_damage"], 0, 5, 1))
    movement = enemy.get("movement")
    if isinstance(movement, dict):
        for key, (low, high, default) in _MOVEMENT_RANGES.items():
            if key in movement:
                movement[key] = _clamp(movement[key], low, high, default)
    attack = enemy.get("attack")
    if isinstance(attack, dict) and attack.get("type") != "none":
        for key, (low, high, default) in _ATTACK_RANGES.items():
            if key in attack:
                attack[key] = _clamp(attack[key], low, high, default)
    for part in enemy.get("parts", []) if isinstance(enemy.get("parts"), list) else []:
        if not isinstance(part, dict):
            continue
        if "hp" in part:
            part["hp"] = int(_clamp(part["hp"], 1, 500, 10))
        for key in ("w", "h"):
            if key in part:
                part[key] = _clamp(part[key], 2, 200, 20)
        if "r" in part:
            part["r"] = _clamp(part["r"], 2, 120, 10)
        offset = part.get("offset")
        if isinstance(offset, dict):
            offset["x"] = _clamp(offset.get("x", 0), -200, 200, 0)
            offset["y"] = _clamp(offset.get("y", 0), -200, 200, 0)


def validate_roster(roster) -> list[str]:
    """Structural validator: every enemy the game engine must be able to run."""
    if not isinstance(roster, list):
        return ["roster must be a JSON array"]
    errors = []
    if not roster:
        errors.append("roster must contain at least one enemy")
    if len(roster) > MAX_ARCHETYPES:
        errors.append(f"roster has {len(roster)} archetypes; maximum is {MAX_ARCHETYPES}")
    seen_ids = set()
    for index, enemy in enumerate(roster):
        tag = f"enemy[{index}]"
        if not isinstance(enemy, dict):
            errors.append(f"{tag} must be an object")
            continue
        enemy_id = enemy.get("id")
        if not isinstance(enemy_id, str) or not enemy_id:
            errors.append(f"{tag} missing string id")
        elif enemy_id in seen_ids:
            errors.append(f"{tag} duplicate id '{enemy_id}'")
        else:
            seen_ids.add(enemy_id)
            tag = enemy_id
        for field in ("name", "desc"):
            if not isinstance(enemy.get(field), str):
                errors.append(f"{tag} {field} must be a string")
        if not _is_number(enemy.get("contact_damage")):
            errors.append(f"{tag} contact_damage must be a number")

        movement = enemy.get("movement")
        if not isinstance(movement, dict) or movement.get("type") not in MOVEMENT_TYPES:
            errors.append(f"{tag} movement.type must be one of {sorted(MOVEMENT_TYPES)}")
        elif movement["type"] in ("patrol", "flyer"):
            for key in ("speed", "range"):
                if not _is_number(movement.get(key)):
                    errors.append(f"{tag} movement.{key} must be a number for a {movement['type']}")

        attack = enemy.get("attack")
        if not isinstance(attack, dict) or attack.get("type") not in ATTACK_TYPES:
            errors.append(f"{tag} attack.type must be one of {sorted(ATTACK_TYPES)}")
        elif attack["type"] != "none":
            for key in ("cooldown_s", "speed", "damage", "range"):
                if not _is_number(attack.get(key)):
                    errors.append(f"{tag} attack.{key} must be a number when attack is active")

        parts = enemy.get("parts")
        if not isinstance(parts, list) or not parts:
            errors.append(f"{tag} must have a non-empty parts array")
            continue
        part_ids = set()
        for part_index, part in enumerate(parts):
            ptag = f"{tag}.parts[{part_index}]"
            if not isinstance(part, dict):
                errors.append(f"{ptag} must be an object")
                continue
            part_id = part.get("id")
            if not isinstance(part_id, str) or not part_id:
                errors.append(f"{ptag} missing string id")
            elif part_id in part_ids:
                errors.append(f"{ptag} duplicate part id '{part_id}'")
            else:
                part_ids.add(part_id)
            shape = part.get("shape")
            if shape not in PART_SHAPES:
                errors.append(f"{ptag} shape must be one of {sorted(PART_SHAPES)}")
            elif shape == "circle":
                if not _is_number(part.get("r")):
                    errors.append(f"{ptag} circle needs a numeric r")
            elif not (_is_number(part.get("w")) and _is_number(part.get("h"))):
                errors.append(f"{ptag} {shape} needs numeric w and h")
            if not _is_hex_color(part.get("color")):
                errors.append(f"{ptag} color must be #RRGGBB")
            if not isinstance(part.get("vulnerable"), bool):
                errors.append(f"{ptag} vulnerable must be true or false")
            if "hp" in part and not _is_number(part["hp"]):
                errors.append(f"{ptag} hp must be a number")
        for part_index, part in enumerate(parts):
            if isinstance(part, dict) and part.get("parent") is not None \
                    and part["parent"] not in part_ids:
                errors.append(f"{tag}.parts[{part_index}] parent '{part['parent']}' is not a part id")
        if not any(isinstance(part, dict) and part.get("vulnerable") for part in parts):
            errors.append(f"{tag} must have at least one vulnerable part so it can be killed")
    return errors


def _resolve_target(roster: list[dict], dotted: str) -> tuple[dict, str]:
    """Walk a dotted patch path to (owning dict, final key). Ids, never indices."""
    segments = dotted.split(".")
    enemy = next((e for e in roster if isinstance(e, dict) and e.get("id") == segments[0]), None)
    if enemy is None:
        raise KeyError(f"no enemy with id '{segments[0]}'")
    node = enemy
    index = 1
    while index < len(segments) - 1:
        segment = segments[index]
        if segment == "parts":
            part_id = segments[index + 1]
            part = next((p for p in node.get("parts", [])
                         if isinstance(p, dict) and p.get("id") == part_id), None)
            if part is None:
                raise KeyError(f"no part '{part_id}' on '{segments[0]}'")
            node = part
            index += 2
        else:
            nxt = node.get(segment) if isinstance(node, dict) else None
            if not isinstance(nxt, dict):
                raise KeyError(f"'{segment}' is not a nested object")
            node = nxt
            index += 1
    return node, segments[-1]


def _apply_op(roster: list[dict], op) -> str | None:
    """Apply one patch op in place; return an error string or None on success."""
    if not isinstance(op, (list, tuple)) or len(op) != 3:
        return "must be [opcode, path, value]"
    opcode, path, value = op
    if opcode not in ("set", "add", "mul"):
        return f"unknown opcode '{opcode}'"
    if not isinstance(path, str) or not path:
        return "path must be a non-empty string"
    if not _is_number(value):
        return f"value for '{path}' must be a number"
    try:
        node, key = _resolve_target(roster, path)
    except (KeyError, TypeError) as exc:
        return f"cannot resolve path '{path}': {exc}"
    if not isinstance(node, dict) or key not in node:
        return f"path '{path}' does not point to an existing field"
    current = node[key]
    if opcode == "set":
        node[key] = value
    elif not _is_number(current):
        return f"cannot {opcode} non-numeric field '{path}'"
    else:
        node[key] = current + value if opcode == "add" else current * value
    return None


def apply_patch(roster: list[dict], patch: dict) -> tuple[list[dict], list[str]]:
    """Validate + apply a patch. Returns (new_roster, errors); the original roster
    is returned unchanged whenever there are any errors (caller-side rollback)."""
    if not isinstance(patch, dict):
        return roster, ["patch must be a JSON object"]
    ops = patch.get("ops")
    if not isinstance(ops, list):
        return roster, ["patch.ops must be an array"]
    if len(ops) > MAX_OPS:
        return roster, [f"patch has {len(ops)} ops; the change budget is {MAX_OPS}"]
    candidate = copy.deepcopy(roster)
    errors = []
    for position, op in enumerate(ops):
        error = _apply_op(candidate, op)
        if error:
            errors.append(f"op[{position}] {error}")
    if errors:
        return roster, errors
    for enemy in candidate:
        _sanitize_enemy(enemy)
    validation_errors = validate_roster(candidate)
    if validation_errors:
        return roster, validation_errors
    return candidate, []


def has_combat_signal(feedback: dict) -> bool:
    """True when the feedback plausibly implicates enemies (plan open question 2)."""
    players = feedback.get("players") or []
    if not players:
        return False
    player = players[0]
    if player.get("enemies_killed") or player.get("hits_taken") or player.get("deaths"):
        return True
    comment = str(player.get("comment", "")).lower()
    return any(keyword in comment for keyword in ENEMY_KEYWORDS)


def adapt(analysis: dict, feedback: dict, roster: list[dict],
          lessons_text: str, previous: dict | None = None,
          errors: list[str] | None = None) -> dict:
    """One Nemotron call: propose an EnemyPatch for the current roster."""
    player = (feedback.get("players") or [{}])[0]
    user = (
        f"CURRENT ENEMY ROSTER (index + 1 = level digit):\n{json.dumps(roster, indent=2)}\n\n"
        f"ANALYST DIAGNOSIS:\n{analysis.get('diagnosis', '(none)')}\n\n"
        f"PLAYER FEEDBACK:\n{json.dumps(feedback, indent=2)}\n\n"
        f"COMBAT SIGNAL: killed {player.get('enemies_killed', 0)}, "
        f"hits taken {player.get('hits_taken', 0)}, deaths {player.get('deaths', 0)}.\n\n"
        f"RELEVANT LESSONS:\n{lessons_text or '(none)'}\n\n"
        "Decide whether any enemy should change this round, and emit the patch."
    )
    if errors:
        user += (
            "\n\nPREVIOUS INVALID PATCH:\n" + json.dumps(previous, separators=(",", ":"))
            + "\n\nPython rejected it for these reasons; fix all of them:\n"
            + "\n".join(f"- {error}" for error in errors)
        )
    result = llm.complete_json(
        SYSTEM, user, model=llm.DESIGNER_MODEL, max_tokens=1500,
        label="enemy designer",
    )
    return result if isinstance(result, dict) else {"ops": []}


def _write_roster(roster: list[dict]):
    ROSTER_PATH.write_text(json.dumps(roster, indent=2))


def _backup_last_good():
    if ROSTER_PATH.exists():
        LAST_GOOD_PATH.parent.mkdir(parents=True, exist_ok=True)
        LAST_GOOD_PATH.write_text(ROSTER_PATH.read_text())


def _log_design(source_round: int, patch: dict):
    DESIGN_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DESIGN_LOG_PATH, "a") as log:
        log.write(json.dumps({
            "ts": datetime.datetime.now().isoformat(timespec="seconds"),
            "source_round": source_round,
            "patch": patch,
        }) + "\n")


def adapt_and_write(analysis: dict, feedback: dict, source_round: int,
                    lessons_text: str = "") -> dict | None:
    """Rollback-safe adaptation: author a patch, validate it, and only write the
    roster when it validates. On repeated failure the roster is left untouched."""
    roster = load_roster()
    if not roster:
        print("  enemy roster is empty; nothing to adapt")
        return None
    if not has_combat_signal(feedback):
        print("  no enemy-related combat signal; roster left unchanged")
        return None

    errors, previous = [], None
    for attempt in range(MAX_ADAPT_ATTEMPTS):
        patch = adapt(analysis, feedback, roster, lessons_text, previous, errors)
        ops = patch.get("ops") if isinstance(patch, dict) else None
        if not ops:
            print("  enemy designer proposed no changes")
            return None
        new_roster, errors = apply_patch(roster, patch)
        previous = patch
        if not errors:
            _backup_last_good()
            _write_roster(new_roster)
            _log_design(source_round, patch)
            print(f"  enemy designer applied {len(ops)} op(s): "
                  f"{str(patch.get('note', '')).strip()[:80]}")
            return patch

    # Every attempt failed validation: keep the previous good roster (rollback).
    print(f"  enemy designer patch rejected after {MAX_ADAPT_ATTEMPTS} attempts; "
          f"roster unchanged: {errors}")
    return None
