"""Designer: turns an LLM-authored JSON plan into a validated tile grid.

The model chooses geometry and encounters using coordinates and rectangles.
Python performs the fragile character counting and grid serialization.
"""

import json

from . import csv_level, llm, object_designer

MAX_ATTEMPTS = 4
MIN_DESIGN_COLS = 250   # hard floor for designed levels — enforced by validation

SYSTEM = f"""You are the Designer for a 2D tile platformer that redesigns itself between
rounds to become more fun. Return ONLY one JSON object describing a level plan. Python
will compile the plan into the character grid; never draw or serialize the grid yourself.

Coordinate system: x grows right from 0; y grows down from 0. A solid rectangle
{{"x": 10, "y": 12, "width": 20, "height": 2}} fills x=10..29 and y=12..13.
The player occupies one empty cell. Gravity pulls down. The player can jump at most
{csv_level.MAX_JUMP_DX} columns across and {csv_level.MAX_JUMP_UP} rows up; drops may be any depth.

Return this exact JSON shape:
{{
  "width": <integer {MIN_DESIGN_COLS}-{csv_level.MAX_COLS}>,
  "height": <integer 12-{csv_level.MAX_ROWS}>,
  "spawn": {{"x": <integer>, "y": <integer>}},
  "exit": {{"x": <integer>, "y": <integer>}},
  "solids": [
    {{"x": <integer>, "y": <integer>, "width": <positive integer>, "height": <positive integer>}}
  ],
  "enemies": [
    {{"type": <integer 1-9>, "x": <integer>, "y": <integer>}}
  ]
}}

Hard rules (validated automatically; violations cost a retry):
- Use at most 200 solid rectangles and {csv_level.MAX_ENEMIES} enemies.
- Every rectangle and entity must be fully inside the level bounds.
- Spawn, exit, and enemy cells must be empty and may not overlap each other.
- Spawn and exit need solid ground directly beneath them.
- Build a continuous reachable route from spawn to exit. Every horizontal gap must be
  at most {csv_level.MAX_JUMP_DX} cells, and upward steps must be at most
  {csv_level.MAX_JUMP_UP} rows.
- Use rectangles for floor runs, platforms, stairs, towers, and walls. Split a floor
  into multiple rectangles only where you intentionally want a pit.

Design guidance:
- The camera scrolls with the player. Design a LONG horizontal journey in acts:
  an opening stretch, distinct middle set-pieces (pit fields, staircases, towers,
  descents, enemy gauntlets), and a finale near the exit.
- Directly address the diagnosis. Too hard -> genuinely reduce demands (narrower pits,
  gentler climbs, fewer enemies). Boring -> add variety and encounters.
- Place enemies deliberately: ground enemies (patrollers, turrets) on platforms with
  room to matter; flyers guarding jumps. Space encounters out — clusters read as unfair.
- Apply the accumulated lessons. Keep what the player enjoyed; change the rest.
- Do not place scene objects. A separate Object Designer reads your completed game
  file and applies an independent object-placement pass after this one.
- Falling into a pit respawns the player at S (costs time, not a life).

Return JSON only. Do not include analysis, markdown, code fences, row strings, or ASCII art."""


def _integer(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    return value


def _point(value, name: str) -> tuple[int, int]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object with integer x and y")
    return _integer(value.get("x"), f"{name}.x"), _integer(value.get("y"), f"{name}.y")


def _nearest_cell(grid, desired, occupied, require_ground: bool):
    """Find the closest legal entity cell to a model-requested coordinate."""
    width, height = len(grid[0]), len(grid)
    cells = []
    for y in range(height - (1 if require_ground else 0)):
        for x in range(width):
            if grid[y][x] != "." or (x, y) in occupied:
                continue
            if require_ground and grid[y + 1][x] != "X":
                continue
            cells.append((x, y))
    if not cells:
        return None
    dx, dy = desired
    return min(cells, key=lambda cell: (abs(cell[0] - dx) + abs(cell[1] - dy),
                                        abs(cell[0] - dx), cell[1], cell[0]))


def _repair_plan(plan: dict) -> tuple[dict, list[str]]:
    """Deterministically repair mechanical mistakes without redesigning geometry."""
    if not isinstance(plan, dict):
        raise ValueError("level plan must be a JSON object")
    corrections: list[str] = []

    raw_width = _integer(plan.get("width"), "width")
    raw_height = _integer(plan.get("height"), "height")
    width = min(csv_level.MAX_COLS, max(MIN_DESIGN_COLS, raw_width))
    height = min(csv_level.MAX_ROWS, max(12, raw_height))
    if (width, height) != (raw_width, raw_height):
        corrections.append(
            f"clamped dimensions from {raw_width}x{raw_height} to {width}x{height}"
        )

    raw_solids = plan.get("solids")
    if not isinstance(raw_solids, list):
        raise ValueError("solids must be an array")
    if len(raw_solids) > 200:
        corrections.append(f"trimmed solids from {len(raw_solids)} to 200 rectangles")
    solids = []
    for index, rect in enumerate(raw_solids[:200]):
        if not isinstance(rect, dict):
            corrections.append(f"removed non-object solids[{index}]")
            continue
        try:
            x = _integer(rect.get("x"), f"solids[{index}].x")
            y = _integer(rect.get("y"), f"solids[{index}].y")
            rect_width = _integer(rect.get("width"), f"solids[{index}].width")
            rect_height = _integer(rect.get("height"), f"solids[{index}].height")
        except ValueError as err:
            corrections.append(f"removed solids[{index}]: {err}")
            continue
        if rect_width <= 0 or rect_height <= 0:
            corrections.append(f"removed non-positive solids[{index}]")
            continue
        left, top = max(0, x), max(0, y)
        right, bottom = min(width, x + rect_width), min(height, y + rect_height)
        if right <= left or bottom <= top:
            corrections.append(f"removed out-of-bounds solids[{index}]")
            continue
        repaired = {"x": left, "y": top, "width": right - left, "height": bottom - top}
        if repaired != rect:
            corrections.append(f"clipped solids[{index}] to the level bounds")
        solids.append(repaired)
    if not solids:
        solids = [{"x": 0, "y": height - 1, "width": width, "height": 1}]
        corrections.append("added a floor because the plan had no usable solids")

    grid = [["." for _ in range(width)] for _ in range(height)]
    for rect in solids:
        for y in range(rect["y"], rect["y"] + rect["height"]):
            for x in range(rect["x"], rect["x"] + rect["width"]):
                grid[y][x] = "X"

    occupied = set()

    def repair_anchor(name: str, default):
        try:
            raw = _point(plan.get(name), name)
        except ValueError:
            raw = default
            corrections.append(f"replaced malformed {name} coordinate")
        desired = (min(width - 1, max(0, raw[0])), min(height - 2, max(0, raw[1])))
        repaired = _nearest_cell(grid, desired, occupied, require_ground=True)
        if repaired is None:
            raise ValueError(f"cannot place {name}: level has no empty cell with solid ground")
        occupied.add(repaired)
        if repaired != raw:
            corrections.append(f"moved {name} from {raw} to legal standable cell {repaired}")
        return {"x": repaired[0], "y": repaired[1]}

    spawn = repair_anchor("spawn", (2, height - 2))
    exit_point = repair_anchor("exit", (width - 3, height - 2))

    raw_enemies = plan.get("enemies", [])
    if not isinstance(raw_enemies, list):
        raw_enemies = []
        corrections.append("replaced malformed enemies value with an empty list")
    if len(raw_enemies) > csv_level.MAX_ENEMIES:
        corrections.append(
            f"trimmed enemies from {len(raw_enemies)} to {csv_level.MAX_ENEMIES}"
        )
    enemies = []
    moved_enemies = 0
    removed_enemies = 0
    for index, enemy in enumerate(raw_enemies[:csv_level.MAX_ENEMIES]):
        if not isinstance(enemy, dict):
            removed_enemies += 1
            continue
        try:
            enemy_type = _integer(enemy.get("type"), f"enemies[{index}].type")
            raw = (_integer(enemy.get("x"), f"enemies[{index}].x"),
                   _integer(enemy.get("y"), f"enemies[{index}].y"))
        except ValueError:
            removed_enemies += 1
            continue
        if not 1 <= enemy_type <= 9:
            removed_enemies += 1
            continue
        desired = (min(width - 1, max(0, raw[0])), min(height - 1, max(0, raw[1])))
        # Type 3 is the current flying enemy; all other known types need ground.
        repaired = _nearest_cell(grid, desired, occupied, require_ground=enemy_type != 3)
        if repaired is None:
            removed_enemies += 1
            continue
        occupied.add(repaired)
        moved_enemies += repaired != raw
        enemies.append({"type": enemy_type, "x": repaired[0], "y": repaired[1]})
    if moved_enemies:
        corrections.append(f"moved {moved_enemies} enemies to legal unoccupied cells")
    if removed_enemies:
        corrections.append(f"removed {removed_enemies} malformed or unplaceable enemies")

    raw_objects = plan.get("objects", [])
    if not isinstance(raw_objects, list):
        raw_objects = []
        corrections.append("replaced malformed objects value with an empty list")
    if len(raw_objects) > 128:
        corrections.append(f"trimmed objects from {len(raw_objects)} to 128 tiles")
    allowed_object_symbols = object_designer.symbols()
    objects = []
    moved_objects = 0
    removed_objects = 0
    for index, scene_object in enumerate(raw_objects[:128]):
        if not isinstance(scene_object, dict):
            removed_objects += 1
            continue
        symbol = str(scene_object.get("symbol") or "")
        try:
            raw = (_integer(scene_object.get("x"), f"objects[{index}].x"),
                   _integer(scene_object.get("y"), f"objects[{index}].y"))
        except ValueError:
            removed_objects += 1
            continue
        if symbol not in allowed_object_symbols:
            removed_objects += 1
            continue
        desired = (min(width - 1, max(0, raw[0])), min(height - 1, max(0, raw[1])))
        repaired = _nearest_cell(grid, desired, occupied, require_ground=False)
        if repaired is None:
            removed_objects += 1
            continue
        occupied.add(repaired)
        moved_objects += repaired != raw
        objects.append({"symbol": symbol, "x": repaired[0], "y": repaired[1]})
    if moved_objects:
        corrections.append(f"moved {moved_objects} objects to legal unoccupied cells")
    if removed_objects:
        corrections.append(f"removed {removed_objects} unknown, malformed, or unplaceable objects")

    return {
        "width": width,
        "height": height,
        "spawn": spawn,
        "exit": exit_point,
        "solids": solids,
        "enemies": enemies,
        "objects": objects,
    }, corrections


def _repair_reachability(candidate: str) -> tuple[str, list[str]]:
    """Add a minimum-change standable route from spawn to exit.

    Dynamic programming searches one column at a time. Existing standable terrain
    is free, adding support costs a little, and carving solid terrain costs more,
    so the connector prefers the model's geometry over drawing a new flat floor.
    """
    grid, parse_errors = csv_level.parse(candidate)
    if parse_errors:
        return candidate, parse_errors
    spawn = csv_level.find_one(grid, "S")
    exit_point = csv_level.find_one(grid, "E")
    if spawn is None or exit_point is None:
        return candidate, ["cannot repair reachability without exactly one spawn and exit"]
    sx, sy = spawn
    ex, ey = exit_point
    if sx == ex:
        return candidate, ["cannot construct a horizontal connector when spawn and exit share a column"]

    rows = len(grid)
    direction = 1 if ex > sx else -1
    columns = list(range(sx, ex + direction, direction))
    backrefs = [{} for _ in columns]
    costs = {sy: 0.0}

    def cell_cost(x, y):
        cell, below = grid[y][x], grid[y + 1][x]
        if below in "SE":
            return None
        cost = 0.0
        if cell == "X":
            cost += 12.0
        elif cell in csv_level.ENEMY_DIGITS:
            cost += 3.0
        if below != "X":
            cost += 2.0 if below == "." else 5.0
        return cost

    for column_index, x in enumerate(columns[1:], start=1):
        next_costs = {}
        for y in range(rows - 1):
            terrain_cost = cell_cost(x, y)
            if terrain_cost is None:
                continue
            choices = [
                (previous_cost + terrain_cost + abs(y - previous_y) * 0.05, previous_y)
                for previous_y, previous_cost in costs.items()
                # Rising is limited to two rows; downward drops may be any depth.
                if previous_y - y <= csv_level.MAX_JUMP_UP
            ]
            if choices:
                best_cost, best_previous_y = min(choices)
                next_costs[y] = best_cost
                backrefs[column_index][y] = best_previous_y
        costs = next_costs

    if ey not in costs:
        return candidate, ["Python could not construct a legal connector path"]

    path = [(ex, ey)]
    current_y = ey
    for column_index in range(len(columns) - 1, 0, -1):
        current_y = backrefs[column_index][current_y]
        path.append((columns[column_index - 1], current_y))
    path.reverse()

    displaced = []
    terrain_edits = 0
    for x, y in path:
        if grid[y][x] not in ".SE":
            if grid[y][x] in csv_level.ENEMY_DIGITS | csv_level.OBJECT_SYMBOLS:
                displaced.append((grid[y][x], x, y))
            grid[y][x] = "."
            terrain_edits += 1
        below = grid[y + 1][x]
        if below != "X":
            if below in csv_level.ENEMY_DIGITS | csv_level.OBJECT_SYMBOLS:
                displaced.append((below, x, y + 1))
            grid[y + 1][x] = "X"
            terrain_edits += 1

    # Restore anchors in case a connector edit touched their cells.
    grid[sy][sx] = "S"
    grid[ey][ex] = "E"

    relocated = 0
    for symbol, old_x, old_y in displaced:
        requires_ground = symbol in csv_level.ENEMY_DIGITS and symbol != "3"
        legal = [
            (x, y)
            for y in range(rows - 1)
            for x in range(len(grid[0]))
            if grid[y][x] == "." and (not requires_ground or grid[y + 1][x] == "X")
        ]
        if legal:
            x, y = min(legal, key=lambda cell: abs(cell[0] - old_x) + abs(cell[1] - old_y))
            grid[y][x] = symbol
            relocated += 1

    repaired = "\n".join("".join(row) for row in grid)
    return repaired, [
        f"built a minimum-change connector path with {terrain_edits} terrain edits"
        + (f" and relocated {relocated} entities/objects" if relocated else "")
    ]


def _compile_plan(plan: dict) -> str:
    """Compile a coordinate plan into a compact grid or raise a useful error."""
    if not isinstance(plan, dict):
        raise ValueError("level plan must be a JSON object")

    width = _integer(plan.get("width"), "width")
    height = _integer(plan.get("height"), "height")
    if not MIN_DESIGN_COLS <= width <= csv_level.MAX_COLS:
        raise ValueError(f"width must be between {MIN_DESIGN_COLS} and {csv_level.MAX_COLS}")
    if not 12 <= height <= csv_level.MAX_ROWS:
        raise ValueError(f"height must be between 12 and {csv_level.MAX_ROWS}")

    solids = plan.get("solids")
    enemies = plan.get("enemies", [])
    objects = plan.get("objects", [])
    if not isinstance(solids, list) or not solids:
        raise ValueError("solids must be a non-empty array")
    if len(solids) > 200:
        raise ValueError("solids may contain at most 200 rectangles")
    if not isinstance(enemies, list):
        raise ValueError("enemies must be an array")
    if len(enemies) > csv_level.MAX_ENEMIES:
        raise ValueError(f"enemies may contain at most {csv_level.MAX_ENEMIES} entries")
    if not isinstance(objects, list):
        raise ValueError("objects must be an array")
    if len(objects) > 128:
        raise ValueError("objects may contain at most 128 entries")

    grid = [["." for _ in range(width)] for _ in range(height)]
    for index, rect in enumerate(solids):
        if not isinstance(rect, dict):
            raise ValueError(f"solids[{index}] must be an object")
        x = _integer(rect.get("x"), f"solids[{index}].x")
        y = _integer(rect.get("y"), f"solids[{index}].y")
        rect_width = _integer(rect.get("width"), f"solids[{index}].width")
        rect_height = _integer(rect.get("height"), f"solids[{index}].height")
        if rect_width <= 0 or rect_height <= 0:
            raise ValueError(f"solids[{index}] width and height must be positive")
        if x < 0 or y < 0 or x + rect_width > width or y + rect_height > height:
            raise ValueError(f"solids[{index}] extends outside the level bounds")
        for row in range(y, y + rect_height):
            for col in range(x, x + rect_width):
                grid[row][col] = "X"

    occupied: set[tuple[int, int]] = set()

    def place(x: int, y: int, tile: str, name: str):
        if not (0 <= x < width and 0 <= y < height):
            raise ValueError(f"{name} is outside the level bounds")
        if grid[y][x] != "." or (x, y) in occupied:
            raise ValueError(f"{name} overlaps a solid or another entity")
        grid[y][x] = tile
        occupied.add((x, y))

    spawn_x, spawn_y = _point(plan.get("spawn"), "spawn")
    exit_x, exit_y = _point(plan.get("exit"), "exit")
    place(spawn_x, spawn_y, "S", "spawn")
    place(exit_x, exit_y, "E", "exit")

    for index, enemy in enumerate(enemies):
        if not isinstance(enemy, dict):
            raise ValueError(f"enemies[{index}] must be an object")
        enemy_type = _integer(enemy.get("type"), f"enemies[{index}].type")
        x = _integer(enemy.get("x"), f"enemies[{index}].x")
        y = _integer(enemy.get("y"), f"enemies[{index}].y")
        if not 1 <= enemy_type <= 9:
            raise ValueError(f"enemies[{index}].type must be between 1 and 9")
        place(x, y, str(enemy_type), f"enemies[{index}]")

    allowed_object_symbols = object_designer.symbols()
    for index, scene_object in enumerate(objects):
        if not isinstance(scene_object, dict):
            raise ValueError(f"objects[{index}] must be an object")
        symbol = str(scene_object.get("symbol") or "")
        if symbol not in allowed_object_symbols:
            raise ValueError(f"objects[{index}].symbol is not in the object catalog")
        x = _integer(scene_object.get("x"), f"objects[{index}].x")
        y = _integer(scene_object.get("y"), f"objects[{index}].y")
        place(x, y, symbol, f"objects[{index}]")

    return "\n".join("".join(row) for row in grid)


def design(level_csv: str, analysis: dict, lessons_text: str, library_text: str,
           player_comment: str = "", roster_text: str = "",
           object_roster_text: str = "", return_plan: bool = False):
    """Return a validated new level as comma-CSV text. Raises RuntimeError on repeated failure."""
    grid, _ = csv_level.parse(level_csv)
    compact_current = csv_level.serialize_compact(grid)
    user = (
        (f"ENEMY ROSTER (digit -> type):\n{roster_text}\n\n" if roster_text else "")
        + f"CURRENT LEVEL:\n{compact_current}\n"
        f"ANALYST DIAGNOSIS:\n{analysis.get('diagnosis', '(none)')}\n\n"
        + (f"THE PLAYER'S OWN WORDS (verbatim — honor explicit requests where the "
           f"format allows):\n\"{player_comment}\"\n\n" if player_comment.strip() else "")
        + f"FUN SCORE: {analysis.get('fun_score', '?')}/5\n\n"
        f"ACCUMULATED LESSONS:\n{lessons_text}\n\n"
        f"REUSABLE LIBRARY:\n{library_text}\n\n"
        "Design the next level."
    )
    errors: list[str] = []
    previous_plan = None
    for attempt in range(MAX_ATTEMPTS):
        prompt = user if not errors else (
            user
            + "\n\nPREVIOUS INVALID PLAN (patch this plan; do not start over):\n"
            + json.dumps(previous_plan, separators=(",", ":"))
            + "\n\nPython applied any safe mechanical repairs, then found these remaining "
              "validation errors — fix ALL of them:\n"
            + "\n".join(f"- {e}" for e in errors)
        )
        raw_plan = llm.complete_json(
            SYSTEM,
            prompt,
            model=llm.DESIGNER_MODEL,
            max_tokens=6000,
            label=f"designer (attempt {attempt + 1})" if attempt else "designer",
        )
        try:
            plan, corrections = _repair_plan(raw_plan)
            candidate = _compile_plan(plan)
            validation_errors = csv_level.validate_text(
                candidate, min_cols=MIN_DESIGN_COLS
            )
            if any(error.startswith("exit is not reachable from spawn")
                   for error in validation_errors):
                candidate, connector_corrections = _repair_reachability(candidate)
                corrections.extend(connector_corrections)
                validation_errors = csv_level.validate_text(
                    candidate, min_cols=MIN_DESIGN_COLS
                )
            errors = [*corrections, *validation_errors] if validation_errors else []
            if corrections:
                print(f"  Python repaired designer plan: {'; '.join(corrections)}")
        except ValueError as err:
            errors = [str(err)]
            plan = raw_plan
        previous_plan = plan
        if not errors:
            new_grid, _ = csv_level.parse(candidate)
            normalized = csv_level.serialize(new_grid)  # normalize to comma-CSV on disk
            return (normalized, plan) if return_plan else normalized
        print(f"  designer attempt {attempt + 1} failed validation ({len(errors)} errors), retrying...")
    raise RuntimeError(f"designer produced no valid level after {MAX_ATTEMPTS} attempts: {errors}")
