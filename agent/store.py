"""Persistent memory: the lessons store and the fun-entity library."""

import json
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
LESSONS_PATH = DATA_DIR / "store" / "lessons.json"
LIBRARY_DIR = DATA_DIR / "library"


def load_lessons() -> list[dict]:
    if LESSONS_PATH.exists():
        return json.loads(LESSONS_PATH.read_text())
    return []


def add_lessons(new_lessons: list[str], source_round: int) -> list[dict]:
    """Append lessons, deduping exact repeats by bumping a counter instead."""
    lessons = load_lessons()
    by_text = {entry["lesson"]: entry for entry in lessons}
    for text in new_lessons:
        text = text.strip()
        if not text:
            continue
        if text in by_text:
            by_text[text]["seen_count"] += 1
        else:
            entry = {"lesson": text, "source_round": source_round, "seen_count": 1}
            lessons.append(entry)
            by_text[text] = entry
    LESSONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    LESSONS_PATH.write_text(json.dumps(lessons, indent=2))
    return lessons


def lessons_as_text() -> str:
    lessons = load_lessons()
    if not lessons:
        return "(no lessons recorded yet)"
    return "\n".join(f"- {entry['lesson']} (seen {entry['seen_count']}x)" for entry in lessons)


def save_to_library(kind: str, entity: dict, why: str, source_round: int) -> Path:
    """Save a fun entity (level / enemy / powerup) for future reuse.

    kind must be one of: levels, enemies, powerups.
    """
    folder = LIBRARY_DIR / kind
    folder.mkdir(parents=True, exist_ok=True)
    name = entity.get("id") or entity.get("name", "entity")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name.lower())
    path = folder / f"{safe}_r{source_round:03d}.json"
    path.write_text(json.dumps({"why_it_worked": why, "source_round": source_round, "entity": entity}, indent=2))
    return path


def library_summary() -> str:
    """Short listing of saved entities the designer can consider reusing."""
    lines = []
    for kind_dir in sorted(LIBRARY_DIR.glob("*")) if LIBRARY_DIR.exists() else []:
        for f in sorted(kind_dir.glob("*.json")):
            data = json.loads(f.read_text())
            lines.append(f"- [{kind_dir.name}] {f.stem}: {data['why_it_worked']}")
    return "\n".join(lines) if lines else "(library is empty)"
