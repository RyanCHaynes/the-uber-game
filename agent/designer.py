"""Designer: produces the next level from the diagnosis and lessons.

Levels travel to/from the LLM in COMPACT form (one character per cell, no
commas — half the tokens of CSV); we convert to comma-CSV on disk. A
validate-and-retry loop feeds errors back, including the hard minimum width.
"""

import re

from . import csv_level, llm

MAX_ATTEMPTS = 3
MIN_DESIGN_COLS = 250   # hard floor for designed levels — enforced by validation

SYSTEM = f"""You are the Designer for a 2D tile platformer that redesigns itself between
rounds to become more fun. Levels are plain-text tile grids: one row per line,
ONE CHARACTER per cell, no commas or spaces. Characters: 'X' solid block, '.' empty,
'S' spawn (exactly one), 'E' exit (exactly one), digits '1'-'9' place an enemy of that
roster type at that cell (max {csv_level.MAX_ENEMIES} enemies). Row 0 is the top; gravity pulls
players down. The player can lob gravity-arcing projectiles with the mouse to fight enemies.

Hard rules (validated automatically — violations are rejected and cost a retry):
- Every row must be the SAME length: {MIN_DESIGN_COLS}-{csv_level.MAX_COLS} characters wide — the minimum
  width is a hard rule, not a suggestion. 12-{csv_level.MAX_ROWS} rows tall.
- Exactly one 'S' and one 'E'. 'E' needs a solid 'X' directly beneath it.
  'S' needs solid ground somewhere below it in its column.
- The player can jump at most {csv_level.MAX_JUMP_DX} columns across and {csv_level.MAX_JUMP_UP} rows up
  (drops can be any depth). Every gap and ledge on the path from S to E must respect this.

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

Respond with ONLY the new level inside a single fenced code block:
```level
...
```"""


def _extract_grid(text: str) -> str:
    fenced = re.search(r"```(?:level|csv)?\s*\n(.*?)```", text, re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    # fall back: keep lines that look like level rows (compact or CSV)
    lines = [l.strip() for l in text.splitlines()
             if len(l.strip()) >= 15 and set(l.strip()) <= set(".XSE123456789,")]
    return "\n".join(lines)


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
        candidate = _extract_grid(llm.complete_text(
            SYSTEM, prompt, model=llm.DESIGNER_MODEL, max_tokens=16000,
            label=f"designer (attempt {attempt + 1})" if attempt else "designer"))
        errors = csv_level.validate_text(candidate, min_cols=MIN_DESIGN_COLS)
        if not errors:
            new_grid, _ = csv_level.parse(candidate)
            return csv_level.serialize(new_grid)   # normalize to comma-CSV on disk
        print(f"  designer attempt {attempt + 1} failed validation ({len(errors)} errors), retrying...")
    raise RuntimeError(f"designer produced no valid level after {MAX_ATTEMPTS} attempts: {errors}")
