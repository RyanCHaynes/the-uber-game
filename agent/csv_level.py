"""CSV tile-level format: parsing, serialization, and validation.

Format: comma-separated cells, one row per line.
    X  solid block      .  empty
    S  spawn (exactly one)   E  exit/finish (exactly one)

Tile size is 32px in the browser game. Validation errors are human-readable
strings meant to be fed back to the LLM designer on retry.
"""

TILE = 32
ALLOWED = {".", "X", "S", "E"}

# Player jump reach in tiles — must stay in sync with the physics constants in
# web/index.html (SPEED/JUMP/GRAVITY). Current tuning clears ~3.8 tiles
# horizontally and ~2.9 tiles up; keep a safety margin.
MAX_JUMP_DX = 3
MAX_JUMP_UP = 2

MIN_ROWS, MAX_ROWS = 8, 40
MIN_COLS, MAX_COLS = 15, 80


def parse(text: str) -> tuple[list[list[str]], list[str]]:
    """Parse CSV text into a grid. Returns (grid, errors)."""
    errors = []
    grid = [[c.strip() for c in line.split(",")] for line in text.strip().splitlines() if line.strip()]
    if not grid:
        return [], ["level is empty"]
    widths = {len(row) for row in grid}
    if len(widths) > 1:
        errors.append(f"rows have inconsistent lengths ({sorted(widths)}) — every row needs the same number of cells")
    bad = sorted({c for row in grid for c in row if c not in ALLOWED})
    if bad:
        errors.append(f"invalid cell values {bad} — only '.', 'X', 'S', 'E' are allowed")
    return grid, errors


def serialize(grid: list[list[str]]) -> str:
    return "\n".join(",".join(row) for row in grid) + "\n"


def find_one(grid, symbol) -> tuple[int, int] | None:
    """Return (col, row) of the unique symbol, or None."""
    hits = [(c, r) for r, row in enumerate(grid) for c, cell in enumerate(row) if cell == symbol]
    return hits[0] if len(hits) == 1 else None


def _standable(grid, c, r) -> bool:
    """A cell the player can stand in: open, with a solid tile directly below."""
    rows, cols = len(grid), len(grid[0])
    if not (0 <= c < cols and 0 <= r < rows - 1):
        return False
    return grid[r][c] in (".", "S", "E") and grid[r + 1][c] == "X"


def validate(grid: list[list[str]]) -> list[str]:
    errors = []
    rows = len(grid)
    cols = len(grid[0]) if grid else 0
    if not (MIN_ROWS <= rows <= MAX_ROWS):
        errors.append(f"level has {rows} rows; must be between {MIN_ROWS} and {MAX_ROWS}")
    if not (MIN_COLS <= cols <= MAX_COLS):
        errors.append(f"level has {cols} columns; must be between {MIN_COLS} and {MAX_COLS}")

    for symbol, label in (("S", "spawn"), ("E", "exit")):
        count = sum(row.count(symbol) for row in grid)
        if count != 1:
            errors.append(f"level must contain exactly one '{symbol}' ({label}); found {count}")
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

    # Reachability: BFS over standable cells with coarse jump rules.
    # From a standable cell you can reach standable cells at most MAX_JUMP_DX
    # columns away, rising at most MAX_JUMP_UP rows (drops are unlimited).
    standables = {(c, r) for r in range(rows) for c in range(cols) if _standable(grid, c, r)}
    seen = {landing}
    frontier = [landing]
    while frontier:
        c, r = frontier.pop()
        for c2, r2 in standables:
            if (c2, r2) not in seen and abs(c2 - c) <= MAX_JUMP_DX and (r - r2) <= MAX_JUMP_UP:
                seen.add((c2, r2))
                frontier.append((c2, r2))
    if (ec, er) not in seen:
        errors.append(
            "exit is not reachable from spawn — the player can jump at most "
            f"{MAX_JUMP_DX} columns across and {MAX_JUMP_UP} rows up; some gap or ledge exceeds that"
        )
    return errors


def validate_text(text: str) -> list[str]:
    grid, errors = parse(text)
    if errors:
        return errors
    return validate(grid)
