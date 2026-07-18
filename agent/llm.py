"""Thin LLM wrapper — the only file that knows which provider we use.

Swapping providers later means reimplementing complete_json() here, nothing else.
"""

import datetime
import json
import os
import re
import time
from pathlib import Path

import anthropic

LOG_PATH = Path(__file__).parent / "data" / "llm_log.jsonl"

# Per-role models: the analyst is judgment/summarization (Sonnet is plenty);
# the designer does spatial grid reasoning (Opus earns its latency there).
# AGENT_MODEL overrides both; per-role vars override individually.
_OVERRIDE = os.environ.get("AGENT_MODEL")
ANALYST_MODEL = _OVERRIDE or os.environ.get("AGENT_ANALYST_MODEL", "claude-sonnet-5")
DESIGNER_MODEL = _OVERRIDE or os.environ.get("AGENT_DESIGNER_MODEL", "claude-opus-4-8")

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def _extract_json(text: str) -> dict:
    """Parse a JSON object out of a model response, tolerating code fences."""
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end == -1:
            raise ValueError(f"no JSON object found in response: {text[:200]!r}")
        text = text[start : end + 1]
    return json.loads(text)


def _call(model: str, system: str, messages: list, max_tokens: int, label: str, attempt: int) -> str:
    """Make one API call and record the complete exchange to the traffic log."""
    t0 = time.time()
    response = _get_client().messages.create(
        model=model,
        max_tokens=max_tokens,
        thinking={"type": "adaptive"},
        system=system,
        messages=messages,
    )
    text = next((b.text for b in response.content if b.type == "text"), "")
    entry = {
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "label": label,
        "model": model,
        "attempt": attempt,
        "duration_s": round(time.time() - t0, 1),
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "system": system,
        "messages": messages,
        "response": text,
    }
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return text


def read_log(limit: int = 100) -> list[dict]:
    if not LOG_PATH.exists():
        return []
    return [json.loads(l) for l in LOG_PATH.read_text().strip().splitlines()[-limit:] if l]


def clear_log():
    LOG_PATH.unlink(missing_ok=True)


def complete_text(system: str, user: str, model: str, max_tokens: int = 8000, label: str = "") -> str:
    """One-shot call returning the raw text response."""
    return _call(model, system, [{"role": "user", "content": user}], max_tokens, label, 1)


def complete_json(system: str, user: str, model: str, max_tokens: int = 8000, label: str = "") -> dict:
    """One-shot call that must return a JSON object. Retries once on a parse failure."""
    messages = [{"role": "user", "content": user}]
    for attempt in range(2):
        text = _call(model, system, messages, max_tokens, label, attempt + 1)
        try:
            return _extract_json(text)
        except (ValueError, json.JSONDecodeError) as err:
            if attempt == 1:
                raise
            messages.append({"role": "assistant", "content": text})
            messages.append({
                "role": "user",
                "content": f"That response was not parseable JSON ({err}). "
                           "Reply again with ONLY a valid JSON object, no prose.",
            })
