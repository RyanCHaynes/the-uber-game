"""Persistent structured memory: lessons, evidence, and reusable entities."""

import copy
import datetime
import json
import math
import re
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
STORE_DIR = DATA_DIR / "store"
LESSONS_PATH = STORE_DIR / "lessons.json"
MEMORY_META_PATH = STORE_DIR / "memory_meta.json"
CONSOLIDATION_LOG_PATH = STORE_DIR / "consolidation_log.jsonl"
LIBRARY_DIR = DATA_DIR / "library"

LESSON_CATEGORIES = {
    "terrain", "enemy_placement", "difficulty", "pacing", "fairness",
    "variety", "combat", "traversal", "other",
}
_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
    "if", "in", "is", "it", "of", "on", "or", "that", "the", "their",
    "this", "to", "with",
}


def _tokens(text: str) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9]+", text.lower())
        if len(token) > 2 and token not in _STOPWORDS
    }


def _text_key(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def _infer_category(text: str) -> str:
    """Give legacy lessons useful groups until new structured evidence replaces them."""
    words = _tokens(text)
    rules = (
        ("enemy_placement", {"enemy", "enemies", "turret", "turrets", "flying", "shooter"}),
        ("fairness", {"unfair", "frustrate", "frustrating", "unreachable"}),
        ("difficulty", {"easy", "hard", "challenge", "challenging", "punishing"}),
        ("variety", {"variety", "repetitive", "repeating", "uniform", "variation"}),
        ("traversal", {"jump", "jumps", "exit", "climb", "climbing", "traversal"}),
        ("terrain", {"terrain", "platform", "platforms", "pit", "pits", "hill", "hills"}),
        ("pacing", {"pacing", "timing", "rhythm", "waves"}),
        ("combat", {"combat", "projectile", "projectiles", "attack", "threat"}),
    )
    return next((category for category, keywords in rules if words & keywords), "other")


def _normalize_lesson(entry, index: int) -> dict:
    """Migrate old string/minimal-dict memories into the structured schema."""
    if isinstance(entry, str):
        entry = {"lesson": entry}
    if not isinstance(entry, dict):
        entry = {"lesson": str(entry)}
    source_round = entry.get("source_round")
    evidence = entry.get("evidence_rounds") or ([] if source_round is None else [source_round])
    category = str(entry.get("category") or _infer_category(str(entry.get("lesson") or "")))
    if category not in LESSON_CATEGORIES:
        category = "other"
    try:
        confidence = min(1.0, max(0.0, float(entry.get("confidence", 0.6))))
    except (TypeError, ValueError):
        confidence = 0.6
    return {
        "id": str(entry.get("id") or f"lesson_{index + 1:04d}"),
        "lesson": str(entry.get("lesson") or "").strip(),
        "category": category,
        "conditions": [str(value).strip() for value in entry.get("conditions", []) if str(value).strip()],
        "outcome": str(entry.get("outcome") or "").strip(),
        "confidence": round(confidence, 2),
        "source_round": source_round,
        "evidence_rounds": sorted({int(value) for value in evidence if isinstance(value, int)}),
        "seen_count": max(1, int(entry.get("seen_count", 1))),
        "applied_count": max(0, int(entry.get("applied_count", 0))),
        "successful_applications": max(0, int(entry.get("successful_applications", 0))),
        "applications": list(entry.get("applications", [])),
        "merged_from": list(entry.get("merged_from", [])),
    }


def load_lessons() -> list[dict]:
    if not LESSONS_PATH.exists():
        return []
    raw = json.loads(LESSONS_PATH.read_text())
    return [lesson for index, entry in enumerate(raw)
            if (lesson := _normalize_lesson(entry, index))["lesson"]]


def _write_lessons(lessons: list[dict]):
    LESSONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    LESSONS_PATH.write_text(json.dumps(lessons, indent=2))


def add_lessons(new_lessons: list, source_round: int) -> list[dict]:
    """Add structured lessons, merging normalized exact matches without losing evidence."""
    lessons = load_lessons()
    by_text = {_text_key(entry["lesson"]): entry for entry in lessons}
    used_ids = {entry["id"] for entry in lessons}
    next_number = len(lessons) + 1

    for raw in new_lessons:
        incoming = _normalize_lesson(raw, next_number - 1)
        text = incoming["lesson"]
        if not text:
            continue
        key = _text_key(text)
        if key in by_text:
            existing = by_text[key]
            existing["seen_count"] += 1
            existing["evidence_rounds"] = sorted(
                set(existing["evidence_rounds"]) | {source_round}
            )
            existing["confidence"] = max(existing["confidence"], incoming["confidence"])
            if existing["category"] == "other" and incoming["category"] != "other":
                existing["category"] = incoming["category"]
            existing["conditions"] = list(dict.fromkeys(
                [*existing["conditions"], *incoming["conditions"]]
            ))
            if not existing["outcome"] and incoming["outcome"]:
                existing["outcome"] = incoming["outcome"]
            continue

        while f"lesson_{next_number:04d}" in used_ids:
            next_number += 1
        incoming.update(
            id=f"lesson_{next_number:04d}",
            source_round=source_round,
            evidence_rounds=[source_round],
        )
        lessons.append(incoming)
        by_text[key] = incoming
        used_ids.add(incoming["id"])
        next_number += 1

    _write_lessons(lessons)
    return lessons


def _relevance(entry: dict, query_tokens: set[str]) -> float:
    lesson_tokens = _tokens(" ".join([
        entry["lesson"], entry["category"], " ".join(entry["conditions"]), entry["outcome"]
    ]))
    overlap = len(query_tokens & lesson_tokens) / math.sqrt(max(1, len(lesson_tokens)))
    return overlap * 4 + entry["confidence"] + math.log2(entry["seen_count"] + 1) * 0.2


def relevant_lessons(query: str = "", limit: int = 12) -> list[dict]:
    lessons = load_lessons()
    query_tokens = _tokens(query)
    if query_tokens:
        lessons.sort(key=lambda entry: _relevance(entry, query_tokens), reverse=True)
    else:
        lessons.sort(key=lambda entry: (entry["seen_count"], entry["confidence"]), reverse=True)
    return lessons[:limit]


def format_lessons(lessons: list[dict]) -> str:
    if not lessons:
        return "(no lessons recorded yet)"
    lines = []
    for entry in lessons:
        detail = f"[{entry['id']} · {entry['category']} · confidence {entry['confidence']:.2f}]"
        evidence = f"seen {entry['seen_count']}x in rounds {entry['evidence_rounds']}"
        line = f"- {detail} {entry['lesson']} ({evidence})"
        if entry["conditions"]:
            line += f" Conditions: {', '.join(entry['conditions'])}."
        if entry["outcome"]:
            line += f" Outcome: {entry['outcome']}."
        lines.append(line)
    return "\n".join(lines)


def lessons_as_text(query: str = "", limit: int = 12) -> str:
    return format_lessons(relevant_lessons(query, limit))


def record_applications(lesson_ids: list[str], design_round: int):
    """Record which retrieved memories grounded a generated level."""
    selected = set(lesson_ids)
    if not selected:
        return
    lessons = load_lessons()
    changed = False
    for entry in lessons:
        if entry["id"] not in selected:
            continue
        if any(app.get("design_round") == design_round for app in entry["applications"]):
            continue
        entry["applications"].append({"design_round": design_round})
        entry["applied_count"] += 1
        changed = True
    if changed:
        _write_lessons(lessons)


def record_feedback_outcome(design_round: int, player_feedback: dict):
    """Attach later player results to the lessons used for that level."""
    lessons = load_lessons()
    changed = False
    rating = int(player_feedback.get("rating", 0))
    success = rating >= 4
    for entry in lessons:
        for application in entry["applications"]:
            if application.get("design_round") != design_round or "rating" in application:
                continue
            application.update({
                "rating": rating,
                "completed": bool(player_feedback.get("completed", False)),
                "deaths": int(player_feedback.get("deaths", 0)),
                "success": success,
            })
            if success:
                entry["successful_applications"] += 1
            changed = True
    if changed:
        _write_lessons(lessons)


def _similarity(first: dict, second: dict) -> float:
    a, b = _tokens(first["lesson"]), _tokens(second["lesson"])
    return len(a & b) / len(a | b) if a and b else 0.0


def _load_memory_meta() -> dict:
    if not MEMORY_META_PATH.exists():
        return {}
    try:
        return json.loads(MEMORY_META_PATH.read_text())
    except (json.JSONDecodeError, TypeError):
        return {}


def should_consolidate(new_lesson_count: int) -> tuple[bool, str]:
    """Run Nemotron only after meaningful growth or likely semantic duplication."""
    lessons = load_lessons()
    if len(lessons) < 5:
        return False, "not enough memory"
    meta = _load_memory_meta()
    growth = len(lessons) - int(meta.get("lesson_count_after", 0))
    likely_overlap = any(
        _similarity(lessons[i], lessons[j]) >= 0.42
        for i in range(len(lessons))
        for j in range(i + 1, len(lessons))
    )
    if likely_overlap and (new_lesson_count > 0 or not meta.get("last_consolidated_at")):
        return True, "likely overlapping lessons"
    if new_lesson_count <= 0:
        return False, "no new knowledge since the last consolidation"
    if growth >= 3:
        return True, f"memory grew by {growth} lessons"
    if len(lessons) >= 25:
        return True, "memory catalog is large"
    return False, "memory growth is not yet material"


def consolidate_lessons(groups: list[dict], reason: str) -> dict:
    """Apply model-proposed duplicate groups while preserving every source record."""
    lessons = load_lessons()
    by_id = {entry["id"]: entry for entry in lessons}
    consumed = set()
    merge_records = []

    for group in groups:
        if not isinstance(group, dict):
            continue
        ids = [str(value) for value in group.get("lesson_ids", [])
               if str(value) in by_id and str(value) not in consumed]
        ids = list(dict.fromkeys(ids))
        if len(ids) < 2:
            continue
        entries = [by_id[lesson_id] for lesson_id in ids]
        source_entries = copy.deepcopy(entries)
        canonical_text = str(group.get("canonical_lesson") or entries[0]["lesson"]).strip()
        if not canonical_text:
            continue
        applications_by_round = {}
        for entry in entries:
            for application in entry["applications"]:
                design_round = application.get("design_round")
                if design_round is not None:
                    applications_by_round.setdefault(design_round, {}).update(application)
        applications = list(applications_by_round.values())
        canonical = entries[0]
        category = str(group.get("category") or canonical["category"])
        if category not in LESSON_CATEGORIES:
            category = "other"
        canonical.update(
            lesson=canonical_text,
            category=category,
            conditions=list(dict.fromkeys(
                [str(value).strip() for value in group.get("conditions", []) if str(value).strip()]
                + [value for entry in entries for value in entry["conditions"]]
            )),
            outcome=str(group.get("outcome") or canonical["outcome"]).strip(),
            confidence=round(min(1.0, max(
                [float(group.get("confidence", 0.0))] + [entry["confidence"] for entry in entries]
            )), 2),
            evidence_rounds=sorted({round_number for entry in entries
                                    for round_number in entry["evidence_rounds"]}),
            seen_count=sum(entry["seen_count"] for entry in entries),
            applied_count=len(applications),
            successful_applications=sum(1 for app in applications if app.get("success")),
            applications=applications,
            merged_from=[
                *canonical["merged_from"],
                *[{"id": entry["id"], "lesson": entry["lesson"]} for entry in entries[1:]],
                *[source for entry in entries[1:] for source in entry["merged_from"]],
            ],
        )
        consumed.update(ids[1:])
        merge_records.append({
            "canonical_id": canonical["id"],
            "merged_ids": ids[1:],
            "source_entries": source_entries,
        })

    compacted = [entry for entry in lessons if entry["id"] not in consumed]
    _write_lessons(compacted)
    now = datetime.datetime.now().isoformat(timespec="seconds")
    report = {
        "ts": now,
        "reason": reason,
        "before_count": len(lessons),
        "after_count": len(compacted),
        "merged_groups": len(merge_records),
        "merges": merge_records,
    }
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONSOLIDATION_LOG_PATH, "a") as log:
        log.write(json.dumps(report) + "\n")
    MEMORY_META_PATH.write_text(json.dumps({
        "last_consolidated_at": now,
        "lesson_count_after": len(compacted),
        "last_reason": reason,
        "last_merged_groups": len(merge_records),
    }, indent=2))
    return report


def memory_status() -> dict:
    lessons = load_lessons()
    meta = _load_memory_meta()
    return {
        "lesson_count": len(lessons),
        "categories": len({entry["category"] for entry in lessons}),
        **meta,
    }


def save_to_library(kind: str, entity: dict, why: str, source_round: int) -> Path:
    """Save a fun entity (level / enemy / powerup) for future reuse."""
    folder = LIBRARY_DIR / kind
    folder.mkdir(parents=True, exist_ok=True)
    name = entity.get("id") or entity.get("name", "entity")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name.lower())
    path = folder / f"{safe}_r{source_round:03d}.json"
    path.write_text(json.dumps({
        "why_it_worked": why, "source_round": source_round, "entity": entity
    }, indent=2))
    return path


def library_summary() -> str:
    """Short listing of saved entities the designer can consider reusing."""
    lines = []
    for kind_dir in sorted(LIBRARY_DIR.glob("*")) if LIBRARY_DIR.exists() else []:
        for path in sorted(kind_dir.glob("*.json")):
            data = json.loads(path.read_text())
            lines.append(f"- [{kind_dir.name}] {path.stem}: {data['why_it_worked']}")
    return "\n".join(lines) if lines else "(library is empty)"
