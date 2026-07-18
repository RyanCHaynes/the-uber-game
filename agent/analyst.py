"""Analyst: turns a real playtest into lessons, a fun score, and a diagnosis."""

import json

from . import llm

SYSTEM = """You are the Analyst for a 2D tile platformer that redesigns itself between rounds.
The level is a CSV tile grid ('X' solid, '.' empty, 'S' spawn, 'E' exit; tiles are 32px,
coordinates in feedback are pixels, y grows downward). A human just playtested it.

Respond with ONLY a JSON object in this exact shape:
{
  "diagnosis": "2-4 sentences: what is and isn't working in this level and why",
  "lessons": [
    {
      "lesson": "short, general, reusable design lesson — only a NEW insight",
      "category": "terrain | enemy_placement | difficulty | pacing | fairness | variety | combat | traversal | other",
      "conditions": ["short conditions under which this lesson applies"],
      "outcome": "the observed player or gameplay consequence",
      "confidence": <0.0-1.0 based on strength of evidence>
    }
  ],
  "fun_score": <1-5>,
  "save_level": <true if this level was a standout (4-5) worth keeping for reuse, else false>,
  "save_reason": "one sentence, only if save_level is true"
}

Guidelines:
- Ground everything in evidence: fall locations, completion, and time are stronger
  signals than the comment alone — but take the comment seriously, it's a real human.
- Falls cluster where the level is unfair or too demanding; zero falls plus a fast
  time plus a low rating means the level is under-stimulating.
- Lessons should generalize ("wide pits right after spawn frustrate players"),
  not restate this level's specifics.
- Do not paraphrase a known lesson as a new lesson. Return an empty lessons array
  when the feedback only confirms existing knowledge."""

CONSOLIDATION_SYSTEM = """You maintain a game-design agent's persistent knowledge catalog.
Find lessons that express the same causal design principle, even when worded differently.
Do NOT merge lessons merely because they share a topic: preserve meaningful distinctions,
conditions, counterexamples, and different outcomes.

Return ONLY this JSON shape:
{
  "groups": [
    {
      "lesson_ids": ["two or more existing lesson IDs that are genuinely redundant"],
      "canonical_lesson": "one concise principle retaining all useful meaning",
      "category": "terrain | enemy_placement | difficulty | pacing | fairness | variety | combat | traversal | other",
      "conditions": ["combined applicability conditions"],
      "outcome": "combined observed consequence",
      "confidence": <0.0-1.0>
    }
  ]
}

Every ID must come from the supplied catalog. Put each ID in at most one group. Return
an empty groups array when no lessons are truly redundant."""


def analyze(level_csv: str, feedback: dict, known_lessons: str) -> dict:
    user = (
        f"KNOWN LESSONS (do not repeat these):\n{known_lessons}\n\n"
        f"LEVEL JUST PLAYED (CSV):\n{level_csv}\n\n"
        f"PLAYTEST FEEDBACK:\n{json.dumps(feedback, indent=2)}"
    )
    return llm.complete_json(SYSTEM, user, model=llm.ANALYST_MODEL, label="analyst")


def consolidate_lessons(lessons: list[dict]) -> list[dict]:
    """Ask Nemotron to identify semantic duplicates in structured memory."""
    user = (
        "LESSON CATALOG:\n"
        + json.dumps(lessons, indent=2)
        + "\n\nConsolidate only genuinely redundant lessons. Preserve distinct causal knowledge."
    )
    result = llm.complete_json(
        CONSOLIDATION_SYSTEM,
        user,
        model=llm.ANALYST_MODEL,
        max_tokens=4000,
        label="memory consolidation",
    )
    groups = result.get("groups", [])
    return groups if isinstance(groups, list) else []
