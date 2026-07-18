"""Designer: turns an LLM-authored JSON plan into a validated tile grid.

The model chooses geometry and encounters using coordinates and rectangles.
Python performs the fragile character counting and grid serialization.
"""

from . import csv_level, llm

MAX_ATTEMPTS = 3
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
    if not isinstance(solids, list) or not solids:
        raise ValueError("solids must be a non-empty array")
    if len(solids) > 200:
        raise ValueError("solids may contain at most 200 rectangles")
    if not isinstance(enemies, list):
        raise ValueError("enemies must be an array")
    if len(enemies) > csv_level.MAX_ENEMIES:
        raise ValueError(f"enemies may contain at most {csv_level.MAX_ENEMIES} entries")

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

    return "\n".join("".join(row) for row in grid)


def design(level_csv: str, analysis: dict, lessons_text: str, library_text: str,
           player_comment: str = "", roster_text: str = "") -> str:
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
    for attempt in range(MAX_ATTEMPTS):
        prompt = user if not errors else (
            user
            + "\n\nYour previous attempt failed validation with these errors — fix ALL of them:\n"
            + "\n".join(f"- {e}" for e in errors)
        )
        plan = llm.complete_json(
            SYSTEM,
            prompt,
            model=llm.DESIGNER_MODEL,
            max_tokens=6000,
            label=f"designer (attempt {attempt + 1})" if attempt else "designer",
        )
        try:
            candidate = _compile_plan(plan)
            errors = csv_level.validate_text(candidate, min_cols=MIN_DESIGN_COLS)
        except ValueError as err:
            errors = [str(err)]
        if not errors:
            new_grid, _ = csv_level.parse(candidate)
            return csv_level.serialize(new_grid)   # normalize to comma-CSV on disk
        print(f"  designer attempt {attempt + 1} failed validation ({len(errors)} errors), retrying...")
    raise RuntimeError(f"designer produced no valid level after {MAX_ATTEMPTS} attempts: {errors}")
