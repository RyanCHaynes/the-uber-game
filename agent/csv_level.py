"""CSV tile-level format: parsing, serialization, and validation.

Format: comma-separated cells, one row per line.
    X  solid block      .  empty
    S  spawn (exactly one)   E  exit/finish (exactly one)

Tile size is 32px in the browser game. Validation errors are human-readable
strings meant to be fed back to the LLM designer on retry.
"""

TILE = 32
ENEMY_DIGITS = set("123456789")  # cell N spawns enemy type N from data/enemies.json
# Uppercase symbols are reserved for safe, data-driven scene objects. S, E and X
# remain structural level markers; object_designer assigns the remaining letters.
OBJECT_SYMBOLS = set("ABCDEFGHIJKLMNOPQRSTUVWYZ") - {"S", "E", "X"}
ALLOWED = {".", "X", "S", "E"} | ENEMY_DIGITS | OBJECT_SYMBOLS
MAX_ENEMIES = 24

# Player jump reach in tiles — must stay in sync with the physics constants in
# web/index.html (SPEED/JUMP/GRAVITY). Current tuning clears ~4.7 tiles
# horizontally and ~4.3 tiles up; keep a safety margin.
MAX_JUMP_DX = 4
MAX_JUMP_UP = 4

MIN_ROWS, MAX_ROWS = 8, 40
MIN_COLS, MAX_COLS = 15, 400


def parse(text: str) -> tuple[list[list[str]], list[str]]:
    """Parse CSV text into a grid. Returns (grid, errors).

    Rows of unequal length are padded with '.' to the widest row rather than
    rejected — at 400 columns, LLM designers reliably miscount by a cell or two,
    and padding is harmless (reachability still validates the result).
    """
    errors = []
    grid = [_split_row(line) for line in text.strip().splitlines() if line.strip()]
    if not grid:
        return [], ["level is empty"]
    width = max(len(row) for row in grid)
    for row in grid:
        row.extend(["."] * (width - len(row)))
    bad = sorted({c for row in grid for c in row if c not in ALLOWED})
    if bad:
        errors.append(
            f"invalid cell values {bad} — use '.', 'X', 'S', 'E', enemy digits 1-9, "
            "or registered uppercase object symbols"
        )
    return grid, errors


def _split_row(line: str) -> list[str]:
    """One level row -> cells. Accepts CSV ('X,.,S') or compact ('X.S') form."""
    line = line.strip()
    if "," in line:
        return [c.strip() for c in line.split(",")]
    return list(line)


def serialize(grid: list[list[str]]) -> str:
    return "\n".join(",".join(row) for row in grid) + "\n"


def serialize_compact(grid: list[list[str]]) -> str:
    """One character per cell, no commas — half the tokens of CSV for LLM traffic."""
    return "\n".join("".join(row) for row in grid) + "\n"


def find_one(grid, symbol) -> tuple[int, int] | None:
    """Return (col, row) of the unique symbol, or None."""
    hits = [(c, r) for r, row in enumerate(grid) for c, cell in enumerate(row) if cell == symbol]
    return hits[0] if len(hits) == 1 else None


def _standable(grid, c, r) -> bool:
    """A cell the player can stand in: open, with a solid tile directly below."""
    rows, cols = len(grid), len(grid[0])
    if not (0 <= c < cols and 0 <= r < rows - 1):
        return False
    return grid[r][c] != "X" and grid[r + 1][c] == "X"  # enemy digits count as open space


def validate(grid: list[list[str]], min_cols: int | None = None) -> list[str]:
    errors = []
    rows = len(grid)
    cols = len(grid[0]) if grid else 0
    floor = max(MIN_COLS, min_cols or 0)
    if not (MIN_ROWS <= rows <= MAX_ROWS):
        errors.append(f"level has {rows} rows; must be between {MIN_ROWS} and {MAX_ROWS}")
    if not (floor <= cols <= MAX_COLS):
        errors.append(f"level has {cols} columns; must be between {floor} and {MAX_COLS}")

    for symbol, label in (("S", "spawn"), ("E", "exit")):
        count = sum(row.count(symbol) for row in grid)
        if count != 1:
            errors.append(f"level must contain exactly one '{symbol}' ({label}); found {count}")

    enemy_count = sum(1 for row in grid for c in row if c in ENEMY_DIGITS)
    if enemy_count > MAX_ENEMIES:
        errors.append(f"level places {enemy_count} enemies; maximum is {MAX_ENEMIES}")
    if errors:
        return errors

    sc, sr = find_one(grid, "S")
    ec, er = find_one(grid, "E")

    # Spawn must land somewhere: some solid tile below it in its column.
    landing = next(((sc, r) for r in range(sr, rows - 1) if _standable(grid, sc, r)), None)
    if landing is None:
        errors.append(f"spawn 'S' at column {sc} falls into a pit — there is no solid ground below it")

    # Exit must be standable so the player can actually touch it.
    if not _standable(grid, ec, er):
        errors.append(f"exit 'E' at column {ec}, row {er} needs a solid 'X' tile directly beneath it")

    if errors:
        return errors

    # Reachability: BFS over standable cells and climbable ladder cells with
    # coarse jump rules. This mirrors the browser's data-driven ladder physics.
    # From a standable cell you can reach standable cells at most MAX_JUMP_DX
    # columns away, rising at most MAX_JUMP_UP rows (drops are unlimited).
    # Standables are indexed by column so long levels stay fast to check.
    by_col: dict[int, list[int]] = {}
    for r in range(rows):
        for c in range(cols):
            if _standable(grid, c, r) or grid[r][c] == "L":
                by_col.setdefault(c, []).append(r)
    seen = {landing}
    frontier = [landing]
    while frontier:
        c, r = frontier.pop()
        # A ladder permits one-tile vertical movement in either direction. It
        # is enough for either endpoint to be ladder so the player can mount or
        # step off the top/bottom of a contiguous ladder run.
        for r2 in (r - 1, r + 1):
            if (0 <= r2 < rows and (c, r2) not in seen
                    and (grid[r][c] == "L" or grid[r2][c] == "L")
                    and (_standable(grid, c, r2) or grid[r2][c] == "L")):
                seen.add((c, r2))
                frontier.append((c, r2))
        for c2 in range(c - MAX_JUMP_DX, c + MAX_JUMP_DX + 1):
            for r2 in by_col.get(c2, ()):
                if (c2, r2) not in seen and (r - r2) <= MAX_JUMP_UP:
                    seen.add((c2, r2))
                    frontier.append((c2, r2))
    if (ec, er) not in seen:
        errors.append(
            "exit is not reachable from spawn — the player can jump at most "
            f"{MAX_JUMP_DX} columns across and {MAX_JUMP_UP} rows up; some gap or ledge exceeds that"
        )
    return errors


def validate_text(text: str, min_cols: int | None = None) -> list[str]:
    grid, errors = parse(text)
    if errors:
        return errors
    return validate(grid, min_cols=min_cols)
