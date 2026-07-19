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
    # Mock only when no backend is viable (no API key AND no claude CLI).
    from . import llm
    return llm.backend() is None


def _get_brains():
    if _use_mock():
        from . import mock
        return mock.analyze, mock.design, "mock"
    from . import analyst, designer
    return analyst.analyze, designer.design, "llm"


def latest_level() -> Path:
    return sorted(LEVELS_DIR.glob("level_*.csv"))[-1]


def roster_summary() -> str:
    """One line per enemy type, for the designer's prompt: '1: Grub — ...'"""
    path = DATA_DIR / "enemies.json"
    if not path.exists():
        return ""
    roster = json.loads(path.read_text())
    return "\n".join(f"{i + 1}: {e['name']} — {e.get('desc', '')}" for i, e in enumerate(roster))


def run_cycle(round_number: int, level_path: Path) -> Path:
    """Process feedback for `round_number` and write the next level. Returns its path."""
    analyze, design, brain = _get_brains()
    from . import llm
    llm.reset_cycle_usage()
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

    player_comment = feedback["players"][0].get("comment", "")
    memory_query = " ".join([
        str(analysis.get("diagnosis", "")),
        player_comment,
        " ".join(
            str(item.get("lesson", "")) if isinstance(item, dict) else str(item)
            for item in new_lessons
        ),
    ])
    selected_memory = store.relevant_lessons(memory_query, limit=12)
    from . import object_designer
    if brain == "llm":
        print("  evaluating scene-object needs (object designer)...")
        try:
            proposals = object_designer.propose(
                analysis, feedback, store.format_lessons(selected_memory)
            )
            added_objects = object_designer.apply_proposals(proposals, round_number)
            if added_objects:
                print("  added object type(s): " + ", ".join(
                    f"{item['name']} [{item['symbol']}]" for item in added_objects
                ))
            else:
                print("  existing object catalog is sufficient")
        except Exception as err:
            # Object ideation is optional; it must never block the next level.
            print(f"  object designer skipped after error: {err}")

    from . import enemy_designer
    if brain == "llm":
        print("  evaluating enemy roster (enemy designer)...")
        try:
            enemy_designer.adapt_and_write(
                analysis, feedback, round_number,
                store.format_lessons(selected_memory),
            )
        except Exception as err:
            # Enemy adaptation is optional; it must never block the next level.
            print(f"  enemy designer skipped after error: {err}")

    print(f"  designing next level ({brain})...")
    new_csv = design(level_csv, analysis, store.lessons_as_text(), store.library_summary(),
                     player_comment=player_comment, roster_text=roster_summary())

    errors = csv_level.validate_text(new_csv)
    if errors:  # llm designer validates internally; this guards the mock path too
        raise RuntimeError(f"generated level failed validation: {errors}")

    next_path = LEVELS_DIR / f"level_{round_number:03d}.csv"
    next_path.write_text(new_csv if new_csv.endswith("\n") else new_csv + "\n")
    # Marker file: the game polls for this to know the next level is ready.
    (LEVELS_DIR / "next_level.ready").write_text(next_path.name)
    usage = llm.cycle_usage()
    print(f"  wrote {next_path.name} — cycle used {usage['used']:,} tokens "
          f"in {usage['calls']} calls (budget {usage['budget']:,})")
    return next_path
