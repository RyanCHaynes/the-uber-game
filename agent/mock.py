"""Offline stand-ins for the Analyst and Designer — no API key required.

Rule-based logic over the CSV grid so the full loop (playtest -> analysis ->
lessons -> new validated level) works end-to-end for free.
"""

import copy
import random

from . import csv_level


def analyze(level_csv: str, feedback: dict, known_lessons: str) -> dict:
    p = feedback["players"][0]
    rating, falls, completed = p["rating"], p["deaths"], p["completed"]

    lessons = []
    if not completed or falls >= 4:
        diagnosis = (f"The playtester fell {falls} times and "
                     f"{'gave up' if not completed else 'barely finished'} — the level is too punishing.")
        lessons.append("Repeated falls at the same obstacle read as unfair; shrink pits before adding new ones")
        fun = min(rating, 2)
    elif rating <= 2:
        diagnosis = (f"Completed in {p['time_seconds']}s with only {falls} falls but rated {rating}/5 — "
                     f"the level is too easy or too empty. Comment: \"{p['comment']}\"")
        lessons.append("Fast, fall-free clears with low ratings mean under-stimulation; add pits, climbs, or detours")
        fun = rating
    else:
        diagnosis = (f"Good round: {rating}/5, {falls} falls, {p['time_seconds']}s. "
                     f"Keep the structure and vary the layout. Comment: \"{p['comment']}\"")
        lessons.append("When a layout rates well, iterate on it instead of replacing it wholesale")
        fun = rating

    return {
        "diagnosis": diagnosis,
        "lessons": lessons,
        "fun_score": fun,
        "save_level": rating >= 4,
        "save_reason": "playtester rated it 4+ stars" if rating >= 4 else "",
    }


def _bottom_gap_columns(grid) -> list[int]:
    """Columns where the bottom two rows are open (i.e. pit columns)."""
    rows = len(grid)
    return [c for c in range(len(grid[0])) if grid[rows - 1][c] != "X" and grid[rows - 2][c] != "X"]


def design(level_csv: str, analysis: dict, lessons_text: str, library_text: str) -> str:
    grid, _ = csv_level.parse(level_csv)
    rng = random.Random(analysis["diagnosis"])
    rows, cols = len(grid), len(grid[0])
    sc, _ = csv_level.find_one(grid, "S")
    ec, _ = csv_level.find_one(grid, "E")

    for _attempt in range(8):
        g = copy.deepcopy(grid)
        fun = analysis["fun_score"]
        pits = _bottom_gap_columns(g)

        if fun <= 2 and "punishing" in analysis["diagnosis"]:
            # easier: fill in one pit column
            if pits:
                c = rng.choice(pits)
                g[rows - 1][c] = g[rows - 2][c] = "X"
        else:
            # spicier: carve a new 2-wide pit away from spawn/exit,
            # or drop in a floating platform
            if rng.random() < 0.6:
                candidates = [c for c in range(2, cols - 3)
                              if abs(c - sc) > 3 and abs(c - ec) > 3
                              and c not in pits and c + 1 not in pits
                              and g[rows - 1][c] == "X" and g[rows - 1][c + 1] == "X"]
                if candidates:
                    c = rng.choice(candidates)
                    for cc in (c, c + 1):
                        g[rows - 1][cc] = g[rows - 2][cc] = "."
            else:
                r = rng.randint(max(2, rows - 6), rows - 4)
                c = rng.randint(2, cols - 5)
                for cc in range(c, min(c + 3, cols)):
                    if g[r][cc] == ".":
                        g[r][cc] = "X"

        if not csv_level.validate(g):
            return csv_level.serialize(g)

    return csv_level.serialize(grid)  # every mutation broke the level; keep it unchanged
