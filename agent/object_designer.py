"""Nemotron-powered scene-object designer with a safe data-only catalog."""

import datetime
import json
import re
from pathlib import Path

from . import csv_level, llm

DATA_DIR = Path(__file__).parent / "data"
CATALOG_PATH = DATA_DIR / "objects.json"
DESIGN_LOG_PATH = DATA_DIR / "store" / "object_design_log.jsonl"
LESSONS_PATH = DATA_DIR / "store" / "object_lessons.json"
MAX_OBJECT_TYPES = 12
MAX_PLACEMENTS = 128
MAX_LADDERS = 32
MAX_HEARTS = 8
MIN_LADDER_LENGTH = 3
MAX_PLACEMENT_ATTEMPTS = 3

BEHAVIORS = {
    "ladder": {
        "description": "climbable vertical tiles that connect elevations",
        "default_symbol": "L",
        "params": {"climb_speed": (1.5, 5.0, 3.2)},
    },
    "bounce": {
        "description": "a floor-mounted spring that launches the player upward",
        "default_symbol": "B",
        "params": {"launch_speed": (8.0, 16.0, 11.5)},
    },
    "hazard": {
        "description": "a non-solid damaging scene tile",
        "default_symbol": "D",
        "params": {"damage": (1.0, 2.0, 1.0)},
    },
    "heal": {
        "description": "a single-use heart that restores the player to full health",
        "default_symbol": "H",
        "params": {},
    },
    "collectible": {
        "description": "a pickup that rewards exploration",
        "default_symbol": "C",
        "params": {"value": (1.0, 100.0, 10.0)},
    },
}

SYSTEM = """You are the Object Designer for a self-improving 2D platformer. Your job is
to decide whether a new reusable scene object would directly address observed player
feedback, then design its identity and safe data parameters. You never write code.

The engine supports exactly these behavior templates:
- ladder: climbable vertical tiles connecting elevations; parameter climb_speed 1.5-5.0
- bounce: floor spring launching the player upward; parameter launch_speed 8.0-16.0
- hazard: non-solid damaging tile; parameter damage 1-2
- collectible: optional pickup rewarding exploration; parameter value 1-100
- heal: single-use heart restoring the player to full health; no parameters

Return ONLY this JSON shape:
{
  "new_objects": [
    {
      "name": "short unique display name",
      "description": "what it adds to level design and when it should be used",
      "behavior": "ladder | bounce | hazard | collectible | heal",
      "color": "#RRGGBB",
      "params": {"the behavior's supported parameter": <number>},
      "design_reason": "the feedback or lesson this object addresses"
    }
  ]
}

Add at most one object per round. Return an empty array when the existing catalog can
already address the feedback. Never propose executable code, scripts, physics formulas,
or behavior names outside the supported templates."""

PLACEMENT_SYSTEM = """You are an expert scene-object placement designer. Study the generated
JSON level plan together with prevalidated object candidates, then choose a small intentional
set. Python derived every candidate from the private grid and historical playtest telemetry.

L IDs are ladders. Use them for vertical routes, alternate paths, recoveries, and pacing.
Python proves ladder candidates mechanically valid by rebuilding the player's navigation graph
with that ladder present.

H IDs are single-use hearts that restore full health. Prefer hearts shortly before progression
regions where the player previously died, especially combat deaths or locations backed by many
hits. Do not place several hearts around one hotspot, and do not select a heart with no death
evidence merely as decoration.

If the level contains no ladder yet and any L candidates are supplied, select at least one.
Critical-access ladders are mandatory. For alternate-route ladders, prefer a small number at
distinct progression points rather than leaving a ladder-free level or filling every short step.

Use the JSON plan's solid rectangles, spawn, exit, enemies, dimensions, and progression to
understand the whole scene. Avoid repetitive evenly spaced ladders; choose a small set whose
locations have distinct gameplay purposes. Prefer priority=critical_access prospects because
they unlock standable regions that traversal validation cannot reach without a ladder. Rank
critical prospects by inaccessible_coverage and unlocked_standable_cells. Candidates with the same unlocked_region_id
serve the same inaccessible region, so select at most one of them. Treat alternate_route
prospects as optional shortcuts, not mandatory decoration. Do not add a ladder merely because
a platform exists; every selection should add useful reachability or a deliberate alternate route.
Return ONLY: {"placements":["L001","H002"]}

Return at most 32 unique candidate IDs exactly as provided. Never invent or modify an ID.
Never include coordinates, reasons, analysis, lessons, prose, markdown, or the game grid.
If no candidate improves the scene, return {"placements":[]}."""


def load_catalog() -> list[dict]:
    if not CATALOG_PATH.exists():
        return []
    data = json.loads(CATALOG_PATH.read_text())
    return data if isinstance(data, list) else []


def roster_summary() -> str:
    catalog = load_catalog()
    if not catalog:
        return "(no scene objects available)"
    return "\n".join(
        f"{item['symbol']}: {item['name']} ({item['behavior']}) — {item['description']}"
        for item in catalog
    )


def symbols() -> set[str]:
    return {item.get("symbol") for item in load_catalog() if item.get("symbol")}


def load_lessons() -> list[dict]:
    if not LESSONS_PATH.exists():
        return []
    try:
        data = json.loads(LESSONS_PATH.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def relevant_lessons(query: str = "", limit: int = 12) -> list[dict]:
    """Retrieve this role's own lessons using lightweight lexical relevance."""
    lessons = load_lessons()
    tokens = set(re.findall(r"[a-z0-9]+", query.lower()))
    def score(item):
        text = " ".join([str(item.get("lesson", "")), str(item.get("outcome", "")),
                         " ".join(item.get("conditions", []))]).lower()
        return (len(tokens & set(re.findall(r"[a-z0-9]+", text))),
                item.get("seen_count", 1), item.get("confidence", 0))
    return sorted(lessons, key=score, reverse=True)[:limit]


def format_lessons(lessons: list[dict]) -> str:
    if not lessons:
        return "(no object-design lessons recorded yet)"
    return "\n".join(
        f"- [{item['id']}] {item['lesson']} (confidence {item.get('confidence', 0):.2f})"
        for item in lessons
    )


def add_lessons(new_lessons: list, source_round: int) -> list[dict]:
    """Persist role-specific lessons, reinforcing normalized exact matches."""
    lessons = load_lessons()
    by_text = {re.sub(r"[^a-z0-9]+", " ", item.get("lesson", "").lower()).strip(): item
               for item in lessons}
    for raw in new_lessons[:5] if isinstance(new_lessons, list) else []:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("lesson") or "").strip()[:300]
        key = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
        if not key:
            continue
        confidence = _safe_number(raw.get("confidence"), 0.0, 1.0, 0.5)
        if key in by_text:
            item = by_text[key]
            item["seen_count"] = item.get("seen_count", 1) + 1
            item["confidence"] = max(item.get("confidence", 0), confidence)
            for field in ("category", "failure_type", "last_error", "last_attempt", "source"):
                if raw.get(field) is not None:
                    item[field] = raw[field]
            if source_round not in item.setdefault("evidence_rounds", []):
                item["evidence_rounds"].append(source_round)
            continue
        item = {
            "id": f"OL-{len(lessons) + 1:03d}", "lesson": text,
            "conditions": [str(v)[:120] for v in raw.get("conditions", [])[:5]]
                          if isinstance(raw.get("conditions"), list) else [],
            "outcome": str(raw.get("outcome") or "").strip()[:240],
            "confidence": confidence, "seen_count": 1,
            "evidence_rounds": [source_round], "role": "object_designer",
            "category": str(raw.get("category") or "object_placement")[:60],
        }
        for field in ("failure_type", "last_error", "last_attempt", "source"):
            if raw.get(field) is not None:
                item[field] = raw[field]
        lessons.append(item)
        by_text[key] = item
    LESSONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    LESSONS_PATH.write_text(json.dumps(lessons, indent=2))
    return lessons


FAILURE_RULES = (
    ("out_of_bounds", ("outside the level bounds", "in-bounds coordinates"),
     "Use only ladder coordinates inside the supplied grid dimensions; never extrapolate the level width.",
     "coordinate selection", "Prevents coordinates that Python cannot map to a grid cell."),
    ("occupied_cells", ("cover only '.' empty cells",),
     "Select a ladder run only when every cell from top_y through bottom_y in its x column is '.'.",
     "terrain intersection", "Prevents ladders from overwriting terrain, entities, spawn, or exit."),
    ("missing_ground", ("needs X directly below bottom_y",),
     "Choose bottom_y so the cell at (x, bottom_y + 1) is solid X ground.",
     "ladder grounding", "Ensures each ladder ends on a mechanically valid lower landing."),
    ("overlap", ("overlaps another ladder run",),
     "Do not select overlapping ladder runs in the same placement patch.",
     "multiple ladders", "Prevents duplicate or intersecting placement coordinates."),
    ("schema", ("must contain only", "must be an array", "coordinates must be integers"),
     "Return only the exact ladder JSON schema with integer x, top_y, and bottom_y fields.",
     "every ladder pass", "Keeps the response machine-readable and free of analysis fields."),
    ("placement_limit", ("maximum is", "is too long"),
     "Keep ladder count and total expanded ladder tiles within the limits stated in the prompt.",
     "large levels", "Prevents oversized placement batches from invalidating the pass."),
)


def record_validation_failures(errors: list[str], source_round: int,
                               attempt: int) -> list[str]:
    """Convert noisy per-coordinate errors into deduplicated persistent rules."""
    grouped = {}
    for error in errors:
        lower = error.lower()
        match = next((rule for rule in FAILURE_RULES
                      if any(marker.lower() in lower for marker in rule[1])), None)
        if match is None:
            match = (
                "other_validation", (),
                "Check every proposed ladder against Python's validation feedback before repeating it.",
                "validator rejection", "Avoids repeating mechanically invalid placement patches.",
            )
        grouped.setdefault(match[0], (match, error))
    raw_lessons = []
    for failure_type, (rule, sample_error) in grouped.items():
        raw_lessons.append({
            "lesson": rule[2], "category": "validation_failure",
            "conditions": [rule[3]], "outcome": rule[4], "confidence": 0.98,
            "failure_type": failure_type, "last_error": sample_error[:300],
            "last_attempt": attempt, "source": "python_validator",
        })
    before_ids = {item.get("failure_type"): item.get("id") for item in load_lessons()}
    updated = add_lessons(raw_lessons, source_round)
    after_ids = {item.get("failure_type"): item.get("id") for item in updated}
    return [after_ids.get(kind) or before_ids.get(kind) for kind in grouped if after_ids.get(kind) or before_ids.get(kind)]


def mark_failures_resolved(lesson_ids: set[str], source_round: int):
    """Record that a later retry successfully corrected previously observed failures."""
    if not lesson_ids:
        return
    lessons = load_lessons()
    changed = False
    for item in lessons:
        if item.get("id") not in lesson_ids:
            continue
        item["successful_corrections"] = item.get("successful_corrections", 0) + 1
        rounds = item.setdefault("resolution_rounds", [])
        if source_round not in rounds:
            rounds.append(source_round)
        changed = True
    if changed:
        LESSONS_PATH.write_text(json.dumps(lessons, indent=2))


def propose(analysis: dict, feedback: dict, lessons_text: str) -> list[dict]:
    """Ask Nemotron whether the current evidence warrants a new object type."""
    user = (
        f"EXISTING OBJECT CATALOG:\n{json.dumps(load_catalog(), indent=2)}\n\n"
        f"ANALYST DIAGNOSIS:\n{analysis.get('diagnosis', '(none)')}\n\n"
        f"PLAYER FEEDBACK:\n{json.dumps(feedback, indent=2)}\n\n"
        f"RELEVANT LESSONS:\n{lessons_text}\n\n"
        "Decide whether one genuinely new object behavior is needed this round."
    )
    result = llm.complete_json(
        SYSTEM,
        user,
        model=llm.ANALYST_MODEL,
        max_tokens=2500,
        label="object designer",
    )
    proposals = result.get("new_objects", [])
    return proposals[:1] if isinstance(proposals, list) else []


def _safe_number(value, low: float, high: float, default: float) -> float:
    try:
        return round(min(high, max(low, float(value))), 2)
    except (TypeError, ValueError):
        return default


def apply_proposals(proposals: list[dict], source_round: int) -> list[dict]:
    """Validate model proposals against engine templates and append safe definitions."""
    catalog = load_catalog()
    if len(catalog) >= MAX_OBJECT_TYPES:
        return []
    used_behaviors = {item.get("behavior") for item in catalog}
    used_symbols = {item.get("symbol") for item in catalog}
    used_ids = {item.get("id") for item in catalog}
    added = []

    for proposal in proposals[:1]:
        if not isinstance(proposal, dict):
            continue
        behavior = str(proposal.get("behavior") or "")
        if behavior not in BEHAVIORS or behavior in used_behaviors:
            continue
        name = str(proposal.get("name") or behavior.title()).strip()[:40]
        object_id = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or behavior
        if object_id in used_ids:
            object_id = f"{object_id}_{source_round}"
        preferred = BEHAVIORS[behavior]["default_symbol"]
        available = [symbol for symbol in sorted(csv_level.OBJECT_SYMBOLS) if symbol not in used_symbols]
        symbol = preferred if preferred not in used_symbols else (available[0] if available else None)
        if symbol is None:
            continue
        color = str(proposal.get("color") or "#6fc3ff")
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            color = "#6fc3ff"
        raw_params = proposal.get("params") if isinstance(proposal.get("params"), dict) else {}
        params = {
            key: _safe_number(raw_params.get(key), low, high, default)
            for key, (low, high, default) in BEHAVIORS[behavior]["params"].items()
        }
        item = {
            "id": object_id,
            "symbol": symbol,
            "name": name,
            "description": str(proposal.get("description") or BEHAVIORS[behavior]["description"]).strip()[:240],
            "behavior": behavior,
            "color": color,
            "params": params,
            "source_round": source_round,
            "design_reason": str(proposal.get("design_reason") or "").strip()[:300],
        }
        catalog.append(item)
        added.append(item)
        used_behaviors.add(behavior)
        used_symbols.add(symbol)
        used_ids.add(object_id)

    if added:
        CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CATALOG_PATH.write_text(json.dumps(catalog, indent=2))
        DESIGN_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(DESIGN_LOG_PATH, "a") as log:
            log.write(json.dumps({
                "ts": datetime.datetime.now().isoformat(timespec="seconds"),
                "source_round": source_round,
                "added": added,
            }) + "\n")
    return added


def _jump_landings(grid: list[list[str]], start_col: int,
                   start_row: int) -> set[tuple[int, int]]:
    """Simulate representative browser-physics jumps from one standable cell."""
    tile, player_w, player_h = csv_level.TILE, 20, 28
    speed, jump, gravity, max_fall = 3.2, 11.76, 0.5, 12
    rows, cols = len(grid), len(grid[0])

    def solid(col, row):
        if col < 0 or col >= cols:
            return True
        if row < 0 or row >= rows:
            return False
        return grid[row][col] == "X"

    landings = set()
    # Releasing horizontal input at different points samples short, medium, and
    # full jumps while using exactly the browser's speed/gravity constants.
    for direction in (-1, 0, 1):
        for hold_frames in ((0,) if direction == 0 else (4, 8, 12, 16, 22, 32, 48)):
            x = start_col * tile + (tile - player_w) / 2
            y = (start_row + 1) * tile - player_h - 0.01
            vy = -jump
            for frame in range(90):
                vx = direction * speed if frame < hold_frames else 0
                vy = min(vy + gravity, max_fall)
                x += vx
                top = int(y // tile)
                bottom = int((y + player_h - 1) // tile)
                if vx > 0:
                    col = int((x + player_w) // tile)
                    if any(solid(col, row) for row in range(top, bottom + 1)):
                        x = col * tile - player_w - 0.01
                elif vx < 0:
                    col = int(x // tile)
                    if any(solid(col, row) for row in range(top, bottom + 1)):
                        x = (col + 1) * tile + 0.01

                y += vy
                left = int(x // tile)
                right = int((x + player_w - 1) // tile)
                grounded = False
                if vy > 0:
                    row = int((y + player_h) // tile)
                    if any(solid(col, row) for col in range(left, right + 1)):
                        y = row * tile - player_h - 0.01
                        vy = 0
                        grounded = True
                elif vy < 0:
                    row = int(y // tile)
                    if any(solid(col, row) for col in range(left, right + 1)):
                        y = (row + 1) * tile + 0.01
                        vy = 0
                if grounded and frame > 1:
                    col = int((x + player_w / 2) // tile)
                    row = int((y + player_h - 1) // tile)
                    if csv_level._standable(grid, col, row):
                        landings.add((col, row))
                    break
                if y > rows * tile + 100:
                    break
    landings.discard((start_col, start_row))
    return landings


def _reachable_cells(grid: list[list[str]]) -> set[tuple[int, int]]:
    """Build a platform navigation graph using collision-aware movement links."""
    spawn = csv_level.find_one(grid, "S")
    if spawn is None:
        return set()
    sc, sr = spawn
    landing = next(((sc, row) for row in range(sr, len(grid) - 1)
                    if csv_level._standable(grid, sc, row)), None)
    if landing is None:
        return set()
    rows, cols = len(grid), len(grid[0])
    seen, frontier = {landing}, [landing]
    while frontier:
        col, row = frontier.pop()
        # Walking links connect adjacent cells on the same platform.
        for next_col in (col - 1, col + 1):
            node = (next_col, row)
            if node not in seen and csv_level._standable(grid, next_col, row):
                seen.add(node); frontier.append(node)
            # Walking off an edge creates a directed fall link to the first
            # landing below. Without these links, lower areas look falsely
            # inaccessible and a ladder can receive inflated credit.
            elif (0 <= next_col < cols and grid[row][next_col] != "X"
                  and not csv_level._standable(grid, next_col, row)):
                for drop_row in range(row + 1, rows - 1):
                    if csv_level._standable(grid, next_col, drop_row):
                        drop = (next_col, drop_row)
                        if drop not in seen:
                            seen.add(drop); frontier.append(drop)
                        break
                    if grid[drop_row][next_col] == "X":
                        break
        for next_row in (row - 1, row + 1):
            if (0 <= next_row < rows and (col, next_row) not in seen
                    and (grid[row][col] == "L" or grid[next_row][col] == "L")
                    and (csv_level._standable(grid, col, next_row)
                         or grid[next_row][col] == "L")):
                seen.add((col, next_row)); frontier.append((col, next_row))
        for node in _jump_landings(grid, col, row):
            if node not in seen:
                seen.add(node); frontier.append(node)
    return seen


def _solid_run_width(grid, col: int, row: int) -> int:
    """Width of the contiguous solid platform containing (col,row)."""
    if not (0 <= row < len(grid) and 0 <= col < len(grid[0])) or grid[row][col] != "X":
        return 0
    left = col
    while left > 0 and grid[row][left - 1] == "X":
        left -= 1
    right = col
    while right + 1 < len(grid[0]) and grid[row][right + 1] == "X":
        right += 1
    return right - left + 1


def ladder_candidates(level_csv: str, max_candidates: int = 160) -> tuple[list[dict], list[str]]:
    """Find meaningful long-wall climbs; reject decorative one-block geometry."""
    grid, errors = csv_level.parse(level_csv)
    if errors:
        return [], errors
    rows, cols = len(grid), len(grid[0])
    reachable = _reachable_cells(grid)
    standable_cells = {
        (col, row) for row in range(rows) for col in range(cols)
        if csv_level._standable(grid, col, row)
    }
    inaccessible_cells = standable_cells - reachable
    raw = []
    for x in range(cols):
        for bottom_y in range(1, rows - 1):
            if grid[bottom_y][x] != "." or grid[bottom_y + 1][x] != "X":
                continue
            if (x, bottom_y) not in reachable:
                continue  # a ladder the player cannot approach is not useful
            for top_y in range(max(0, bottom_y - 13), bottom_y):
                length = bottom_y - top_y + 1
                if length < MIN_LADDER_LENGTH:
                    continue  # two-cell runs do not create a readable climb
                if any(grid[y][x] != "." for y in range(top_y, bottom_y + 1)):
                    continue
                for neighbor in (x - 1, x + 1):
                    if not (0 <= neighbor < cols and top_y + 1 < rows):
                        continue
                    if grid[top_y][neighbor] == "X" or grid[top_y + 1][neighbor] != "X":
                        continue
                    platform_width = _solid_run_width(grid, neighbor, top_y + 1)
                    if platform_width < 3:
                        continue  # one/two-block decorations are not destinations
                    wall_depth = 0
                    for wall_y in range(top_y + 1, bottom_y + 1):
                        if grid[wall_y][neighbor] != "X":
                            break
                        wall_depth += 1
                    upper_landing = (neighbor, top_y)
                    # Evaluate the ladder as an off-mesh traversal link: add it
                    # temporarily, rebuild connectivity, and measure playable
                    # standable space that becomes reachable from spawn.
                    for ladder_y in range(top_y, bottom_y + 1):
                        grid[ladder_y][x] = "L"
                    with_ladder = _reachable_cells(grid)
                    for ladder_y in range(top_y, bottom_y + 1):
                        grid[ladder_y][x] = "."
                    unlocked = (with_ladder - reachable) & standable_cells
                    unlocked_count = len(unlocked)
                    is_long_wall = wall_depth >= 3
                    is_substantial_step = wall_depth >= 2 and platform_width >= 5
                    if unlocked_count < 3 and not (is_long_wall or is_substantial_step):
                        continue
                    inaccessible = upper_landing not in reachable
                    unlocked_columns = sorted({col for col, _ in unlocked})
                    unlocked_rows = sorted({row for _, row in unlocked})
                    unlocked_region_id = (
                        f"c{unlocked_columns[0]}-{unlocked_columns[-1]}_"
                        f"r{unlocked_rows[0]}-{unlocked_rows[-1]}"
                        if unlocked_columns and unlocked_rows else "none"
                    )
                    raw.append({
                        "x": x, "top_y": top_y, "bottom_y": bottom_y,
                        "length": length, "wall_height": wall_depth,
                        "wall_side": "right" if neighbor > x else "left",
                        "upper_landing": {"x": neighbor, "y": top_y},
                        "upper_platform_width": platform_width,
                        "access_without_ladder": "unreachable" if inaccessible else "reachable_by_alternate_route",
                        "candidate_type": (
                            "long_wall_climb" if is_long_wall else
                            "elevated_platform_access" if unlocked_count >= 3 else
                            "step_route"
                        ),
                        "unlocked_standable_cells": unlocked_count,
                        "inaccessible_coverage": round(
                            unlocked_count / len(inaccessible_cells), 3
                        ) if inaccessible_cells else 0.0,
                        "unlocked_column_span": (
                            [unlocked_columns[0], unlocked_columns[-1]] if unlocked_columns else []
                        ),
                        "unlocked_region_id": unlocked_region_id,
                        "priority": "critical_access" if unlocked_count >= 3 else "alternate_route",
                        "_unlocked_cells": unlocked,
                    })
    # Prefer walls that unlock otherwise unreachable space, then taller walls
    # and substantial platforms. Coordinates break ties deterministically.
    raw.sort(key=lambda item: (
        item["priority"] != "critical_access", -item["unlocked_standable_cells"],
        -item["wall_height"],
        -item["upper_platform_width"], item["x"], item["top_y"],
    ))
    # Different ladder columns can unlock the same disconnected component. Keep
    # only the highest-gain prospect for that region so Nemotron sees meaningful
    # choices rather than coordinate-level duplicates.
    deduplicated = []
    used_destinations = set()
    covered_critical_cells = set()
    for item in raw:
        if item["priority"] == "critical_access":
            novel_cells = item["_unlocked_cells"] - covered_critical_cells
            if len(novel_cells) < 3:
                continue
            key = ("region", item["unlocked_region_id"])
        else:
            key = ("landing", item["upper_landing"]["x"],
                   item["upper_landing"]["y"], item["bottom_y"])
        if key in used_destinations:
            continue
        used_destinations.add(key)
        if item["priority"] == "critical_access":
            covered_critical_cells.update(item["_unlocked_cells"])
        item.pop("_unlocked_cells", None)
        deduplicated.append(item)
    raw = deduplicated
    # Keep broad horizontal coverage when a large level has many possibilities.
    if len(raw) > max_candidates:
        raw = [raw[round(i * (len(raw) - 1) / (max_candidates - 1))]
               for i in range(max_candidates)]
    candidates = [{"id": f"L{index:03d}", **item} for index, item in enumerate(raw, 1)]
    return candidates, []


def heart_candidates(level_csv: str, feedback: dict,
                     max_candidates: int = MAX_HEARTS) -> tuple[list[dict], list[str]]:
    """Map historical death progress to reachable recovery points in the new level."""
    grid, errors = csv_level.parse(level_csv)
    if errors:
        return [], errors
    rows, cols = len(grid), len(grid[0])
    players = feedback.get("players", []) if isinstance(feedback, dict) else []
    deaths = []
    hits_taken = 0
    for player in players if isinstance(players, list) else []:
        if not isinstance(player, dict):
            continue
        try:
            hits_taken += max(0, int(player.get("hits_taken", 0)))
        except (TypeError, ValueError):
            pass
        locations = player.get("fall_locations", [])
        for location in locations if isinstance(locations, list) else []:
            if not isinstance(location, dict):
                continue
            try:
                deaths.append({
                    "x": float(location["x"]),
                    "cause": str(location.get("cause") or "unknown"),
                })
            except (KeyError, TypeError, ValueError):
                continue
    if not deaths:
        return [], []

    # Feedback coordinates belong to the previously played level. Preserve
    # progression rather than raw x so a death at 70% maps sensibly into a
    # newly generated level with a different width.
    old_cols = 0
    level_name = Path(str(feedback.get("level") or "")).stem
    old_path = DATA_DIR / "levels" / f"{level_name}.csv"
    if level_name and old_path.exists():
        old_grid, old_errors = csv_level.parse(old_path.read_text())
        if not old_errors:
            old_cols = len(old_grid[0])
    if not old_cols:
        old_cols = max(cols, int(max(item["x"] for item in deaths) / csv_level.TILE) + 1)
    for item in deaths:
        item["progress"] = min(1.0, max(0.0, item["x"] / (old_cols * csv_level.TILE)))

    # Nearby deaths are one hotspot. Each cluster should yield at most one
    # heart, preventing a repeated failure from flooding the area with healing.
    clusters = []
    for item in sorted(deaths, key=lambda entry: entry["progress"]):
        if clusters and item["progress"] - clusters[-1][-1]["progress"] <= 0.04:
            clusters[-1].append(item)
        else:
            clusters.append([item])

    reachable = _reachable_cells(grid)
    spawn = csv_level.find_one(grid, "S")
    exit_cell = csv_level.find_one(grid, "E")
    def legal_cells(spawn_buffer: int, exit_buffer: int):
        return [
            (col, row) for col, row in reachable
            if grid[row][col] == "."
            and (spawn is None or abs(col - spawn[0]) >= spawn_buffer)
            and (exit_cell is None or abs(col - exit_cell[0]) >= exit_buffer)
        ]

    legal = legal_cells(6, 3) or legal_cells(2, 1)
    candidates = []
    used_columns = []
    for cluster in sorted(clusters, key=len, reverse=True):
        progress = sum(item["progress"] for item in cluster) / len(cluster)
        # Place recovery shortly before the historical danger point so it can
        # help, rather than after the player has already died.
        target_col = max(0, round(progress * (cols - 1)) - 5)
        choices = [cell for cell in legal if all(abs(cell[0] - used) >= 10 for used in used_columns)]
        if not choices:
            continue
        col, row = min(choices, key=lambda cell: (
            abs(cell[0] - target_col), abs(cell[1] - rows // 2), cell[0], cell[1]
        ))
        used_columns.append(col)
        combat_deaths = sum(item["cause"] == "combat" for item in cluster)
        candidates.append({
            "id": f"H{len(candidates) + 1:03d}",
            "kind": "heart", "symbol": "H", "x": col, "y": row, "length": 1,
            "historical_deaths": len(cluster), "combat_deaths": combat_deaths,
            "hits_taken_in_playtest": hits_taken,
            "prior_progress": round(progress, 3),
            "placement_relation": "shortly_before_historical_death_hotspot",
            "priority": "critical_recovery" if combat_deaths or len(cluster) > 1 else "recovery",
        })
        if len(candidates) >= max_candidates:
            break
    return candidates, []


def placement_candidates(level_csv: str, feedback: dict) -> tuple[list[dict], list[str]]:
    ladders, errors = ladder_candidates(level_csv)
    if errors:
        return [], errors
    hearts, errors = heart_candidates(level_csv, feedback)
    if errors:
        return [], errors
    return ladders + hearts, []


def _candidate_cells(candidate: dict) -> set[tuple[int, int]]:
    if candidate.get("kind") == "heart":
        return {(candidate["x"], candidate["y"])}
    return {(candidate["x"], y)
            for y in range(candidate["top_y"], candidate["bottom_y"] + 1)}


def _apply_placement_patch(level_csv: str, patch: dict,
                           candidates: list[dict] | None = None) -> tuple[str, list[str]]:
    """Resolve prevalidated candidate IDs without exposing coordinate work to the model."""
    grid, errors = csv_level.parse(level_csv)
    if errors:
        return level_csv, errors
    candidates = candidates if candidates is not None else ladder_candidates(level_csv)[0]
    by_id = {candidate["id"]: candidate for candidate in candidates}
    placements = patch.get("placements", []) if isinstance(patch, dict) else None
    if not isinstance(placements, list):
        return level_csv, ["placements must be an array"]
    if set(patch) != {"placements"}:
        errors.append("response must contain only the 'placements' field")
    if len(placements) > MAX_LADDERS:
        errors.append(f"placements contains {len(placements)} IDs; maximum is {MAX_LADDERS}")
    if any(not isinstance(candidate_id, str) for candidate_id in placements):
        errors.append("every placement must be a candidate ID string")
    unknown = sorted({candidate_id for candidate_id in placements
                      if isinstance(candidate_id, str) and candidate_id not in by_id})
    if unknown:
        errors.append(f"unknown candidate IDs: {unknown}")
    if len(set(placements)) != len(placements):
        errors.append("placement candidate IDs must be unique")
    selected = [by_id[candidate_id] for candidate_id in placements if candidate_id in by_id]
    available_ladders = [item for item in candidates if item.get("id", "").startswith("L")]
    selected_ladders = [item for item in selected if item.get("id", "").startswith("L")]
    level_has_ladder = any("L" in row for row in grid)
    if available_ladders and not selected_ladders and not level_has_ladder:
        errors.append(
            "the ladder-free level has prevalidated L candidates; select at least one ladder ID"
        )
    selected_hearts = sum(item.get("kind") == "heart" for item in selected)
    if selected_hearts > MAX_HEARTS:
        errors.append(f"selected hearts exceed the {MAX_HEARTS}-heart maximum")
    if sum(item["length"] for item in selected) > MAX_PLACEMENTS:
        errors.append(f"selected ladders exceed the {MAX_PLACEMENTS}-tile maximum")
    occupied = set()
    for item in selected:
        cells = _candidate_cells(item)
        if cells & occupied:
            errors.append("selected ladder runs overlap another ladder run")
        occupied.update(cells)
    if errors:
        return level_csv, errors

    for candidate in selected:
        symbol = candidate.get("symbol", "L")
        for x, y in _candidate_cells(candidate):
            grid[y][x] = symbol
    validation_errors = csv_level.validate(grid)
    if validation_errors:
        return level_csv, validation_errors
    return csv_level.serialize(grid), []


def place_objects(level_csv: str, level_plan: dict | None, analysis: dict,
                  feedback: dict, source_round: int) -> tuple[str, dict]:
    """Run the independent Nemotron object-placement pass on the game file."""
    # This role receives its complete history by design. The lesson store still
    # deduplicates repeated validator failures so the system prompt grows with
    # distinct knowledge rather than raw retry noise.
    known_lessons = load_lessons()
    candidates, candidate_errors = placement_candidates(level_csv, feedback)
    if candidate_errors:
        raise RuntimeError(f"cannot derive object candidates: {candidate_errors}")
    placement_system = (
        PLACEMENT_SYSTEM
        + "\n\nCOMPLETE PERSISTENT OBJECT-PLACEMENT LESSON HISTORY "
          "(follow every lesson as a hard-earned rule):\n"
        + format_lessons(known_lessons)
    )
    base_user = (
        f"PLAYER FEEDBACK:\n{json.dumps(feedback, indent=2)}\n\n"
        f"ANALYST DIAGNOSIS:\n{analysis.get('diagnosis', '(none)')}\n\n"
        f"GENERATED JSON LEVEL PLAN:\n{json.dumps(level_plan or {}, separators=(',', ':'))}\n\n"
        f"PREVALIDATED OBJECT PLACEMENT CANDIDATES:\n{json.dumps(candidates, separators=(',', ':'))}\n\n"
        "Return only selected candidate IDs in the required JSON shape."
    )
    errors = []
    previous = None
    observed_failure_ids: set[str] = set()
    for attempt in range(MAX_PLACEMENT_ATTEMPTS):
        user = base_user
        if errors:
            user += (
                "\n\nPREVIOUS INVALID OBJECT PATCH:\n"
                + json.dumps(previous, separators=(",", ":"))
                + "\n\nPython rejected it for these reasons; patch the JSON and fix all errors:\n"
                + "\n".join(f"- {error}" for error in errors)
            )
        result = llm.complete_json(
            placement_system, user, model=llm.DESIGNER_MODEL, max_tokens=1000,
            label=f"object placement designer (attempt {attempt + 1})" if attempt else "object placement designer",
        )
        edited_csv, errors = _apply_placement_patch(level_csv, result, candidates)
        previous = result
        if not errors:
            mark_failures_resolved(observed_failure_ids, source_round)
            return edited_csv, result
        observed_failure_ids.update(
            record_validation_failures(errors, source_round, attempt + 1)
        )
    raise RuntimeError(
        f"object placement designer produced no valid patch after {MAX_PLACEMENT_ATTEMPTS} attempts: {errors}"
    )
