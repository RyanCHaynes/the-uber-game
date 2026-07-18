"""Designer: produces the next CSV level from the diagnosis and lessons.

Runs a validate-and-retry loop: if the generated level fails structural or
reachability checks, the errors are fed back and the model fixes them.
"""

import re

from . import csv_level, llm

MAX_ATTEMPTS = 3

SYSTEM = f"""You are the Designer for a 2D tile platformer that redesigns itself between
rounds to become more fun. Levels are CSV tile grids: one row per line, cells separated
by commas. Cell values: 'X' solid block, '.' empty, 'S' spawn (exactly one),
'E' exit (exactly one). Row 0 is the top; gravity pulls players down.

Hard rules (validated automatically — violations are rejected):
- Every row must have the same number of cells. {csv_level.MIN_ROWS}-{csv_level.MAX_ROWS} rows, {csv_level.MIN_COLS}-{csv_level.MAX_COLS} columns.
- Exactly one 'S' and one 'E'. 'E' needs a solid 'X' directly beneath it.
  'S' needs solid ground somewhere below it in its column.
- The player can jump at most {csv_level.MAX_JUMP_DX} columns across and {csv_level.MAX_JUMP_UP} rows up
  (drops can be any depth). Every gap and ledge on the path from S to E must respect this.

Design guidance:
- Directly address the diagnosis. Too hard -> genuinely reduce demands (narrower pits,
  gentler climbs). Boring -> add variety: pits, staircases, towers, drops, detours.
- Apply the accumulated lessons.
- Change enough that the round feels fresh, but keep what the player enjoyed.
- Falling into a pit respawns the player at S (costs time, not a life).

Respond with ONLY the new level as CSV inside a single fenced code block:
```csv
...
```"""


def _extract_csv(text: str) -> str:
    fenced = re.search(r"```(?:csv)?\s*\n(.*?)```", text, re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    # fall back: keep only lines that look like CSV rows
    lines = [l for l in text.splitlines() if "," in l and set(l.replace(",", "").strip()) <= set(".XSE ")]
    return "\n".join(lines)


def design(level_csv: str, analysis: dict, lessons_text: str, library_text: str) -> str:
    """Return a validated new level as CSV text. Raises RuntimeError on repeated failure."""
    user = (
        f"CURRENT LEVEL (CSV):\n{level_csv}\n\n"
        f"ANALYST DIAGNOSIS:\n{analysis.get('diagnosis', '(none)')}\n\n"
        f"FUN SCORE: {analysis.get('fun_score', '?')}/5\n\n"
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
        candidate = _extract_csv(llm.complete_text(
            SYSTEM, prompt, model=llm.DESIGNER_MODEL, max_tokens=12000,
            label=f"designer (attempt {attempt + 1})" if attempt else "designer"))
        errors = csv_level.validate_text(candidate)
        if not errors:
            return candidate
        print(f"  designer attempt {attempt + 1} failed validation ({len(errors)} errors), retrying...")
    raise RuntimeError(f"designer produced no valid level after {MAX_ATTEMPTS} attempts: {errors}")
