"""Analyst: turns a real playtest into lessons, a fun score, and a diagnosis."""

import json

from . import llm

SYSTEM = """You are the Analyst for a 2D tile platformer that redesigns itself between rounds.
The level is a CSV tile grid ('X' solid, '.' empty, 'S' spawn, 'E' exit; tiles are 32px,
coordinates in feedback are pixels, y grows downward). A human just playtested it.

Respond with ONLY a JSON object in this exact shape:
{
  "diagnosis": "2-4 sentences: what is and isn't working in this level and why",
  "lessons": ["short, general, reusable design lessons — only NEW insights not already in the known-lessons list"],
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
  not restate this level's specifics."""


def analyze(level_csv: str, feedback: dict, known_lessons: str) -> dict:
    user = (
        f"KNOWN LESSONS (do not repeat these):\n{known_lessons}\n\n"
        f"LEVEL JUST PLAYED (CSV):\n{level_csv}\n\n"
        f"PLAYTEST FEEDBACK:\n{json.dumps(feedback, indent=2)}"
    )
    return llm.complete_json(SYSTEM, user, model=llm.ANALYST_MODEL, label="analyst")
