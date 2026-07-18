"""Orchestrator: one full between-rounds cycle, driven by real playtests.

    feedback.json (from the browser game)  ->  Analyst  ->  lessons store + library
                                                 |
                                                 v
                                              Designer (validate + retry)  ->  next level_NNN.csv
"""

import json
import os
from pathlib import Path

from . import csv_level, store

DATA_DIR = Path(__file__).parent / "data"
LEVELS_DIR = DATA_DIR / "levels"
ROUNDS_DIR = DATA_DIR / "rounds"


def _use_mock() -> bool:
    if os.environ.get("AGENT_MOCK") == "1":
        return True
    # No explicit choice: fall back to mock when no credentials are available.
    return not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("ANTHROPIC_AUTH_TOKEN")


def _get_brains():
    if _use_mock():
        from . import mock
        return mock.analyze, mock.design, "mock"
    from . import analyst, designer
    return analyst.analyze, designer.design, "llm"


def latest_level() -> Path:
    return sorted(LEVELS_DIR.glob("level_*.csv"))[-1]


def run_cycle(round_number: int, level_path: Path) -> Path:
    """Process feedback for `round_number` and write the next level. Returns its path."""
    analyze, design, brain = _get_brains()
    level_csv = level_path.read_text()
    feedback_path = ROUNDS_DIR / f"round_{round_number:03d}" / "feedback.json"
    feedback = json.loads(feedback_path.read_text())

    print(f"[round {round_number}] analyzing playtest ({brain})...")
    analysis = analyze(level_csv, feedback, store.lessons_as_text())
    (feedback_path.parent / "analysis.json").write_text(json.dumps(analysis, indent=2))
    print(f"  diagnosis: {analysis['diagnosis']}")

    new_lessons = analysis.get("lessons", [])
    if new_lessons:
        store.add_lessons(new_lessons, round_number)
        print(f"  recorded {len(new_lessons)} lesson(s)")

    if analysis.get("save_level"):
        store.save_to_library(
            "levels",
            {"name": level_path.stem, "csv": level_csv},
            analysis.get("save_reason", ""),
            round_number,
        )
        print(f"  saved to library: levels/{level_path.stem}")

    print(f"  designing next level ({brain})...")
    new_csv = design(level_csv, analysis, store.lessons_as_text(), store.library_summary())

    errors = csv_level.validate_text(new_csv)
    if errors:  # llm designer validates internally; this guards the mock path too
        raise RuntimeError(f"generated level failed validation: {errors}")

    next_path = LEVELS_DIR / f"level_{round_number:03d}.csv"
    next_path.write_text(new_csv if new_csv.endswith("\n") else new_csv + "\n")
    # Marker file: the game polls for this to know the next level is ready.
    (LEVELS_DIR / "next_level.ready").write_text(next_path.name)
    print(f"  wrote {next_path.name}")
    return next_path
