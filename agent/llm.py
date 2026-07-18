"""Thin LLM wrapper — the only file that knows which provider we use.

Swapping providers later means reimplementing complete_json() here, nothing else.
"""

import datetime
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

import anthropic

LOG_PATH = Path(__file__).parent / "data" / "llm_log.jsonl"

# Hard token budget per agent cycle (analyst + designer + retries, all backends).
# Counts input + cache-creation + output. Once exhausted, further LLM calls in
# the cycle raise instead of running — the round fails cleanly and cheaply.
CYCLE_BUDGET = int(os.environ.get("AGENT_TOKEN_BUDGET", "60000"))
_cycle = {"used": 0, "calls": 0}


def reset_cycle_usage():
    _cycle["used"] = 0
    _cycle["calls"] = 0


def cycle_usage() -> dict:
    return {"used": _cycle["used"], "calls": _cycle["calls"], "budget": CYCLE_BUDGET}


class BudgetExceeded(RuntimeError):
    pass


def backend() -> str | None:
    """Which LLM backend to use.

    'api'         -> Anthropic API (billed in API credits)
    'claude_code' -> headless `claude -p` (billed to the Claude subscription)
    None          -> neither available; pipeline falls back to mock
    """
    choice = os.environ.get("AGENT_BACKEND")
    if choice in ("api", "claude_code"):
        return choice
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "api"
    if shutil.which("claude"):
        return "claude_code"
    return None

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


def _flatten_for_cli(messages: list) -> str:
    """claude -p takes one prompt string; fold retry turns into labeled sections."""
    if len(messages) == 1:
        return messages[0]["content"]
    parts = []
    for m in messages:
        tag = "YOUR PREVIOUS RESPONSE" if m["role"] == "assistant" else "USER"
        parts.append(f"[{tag}]\n{m['content']}")
    return "\n\n".join(parts)


def _call_claude_code(model: str, system: str, messages: list) -> tuple[str, dict]:
    """One exchange via headless Claude Code. Returns (text, usage_dict)."""
    alias = next((a for a in ("opus", "sonnet", "haiku") if a in model), model)
    prompt = _flatten_for_cli(messages)
    # Deny all tools: Claude Code otherwise tries to Write big outputs to files,
    # burning the turn budget before producing a final text answer.
    no_tools = "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit"
    cmd = ["claude", "-p", prompt, "--model", alias,
           "--output-format", "json", "--max-turns", "3",
           "--disallowedTools", no_tools,
           "--system-prompt",
           system + "\n\nIMPORTANT: reply directly with the requested output as plain "
                    "text in your response. Never use tools; never write files."]
    # Strip API credentials so the CLI bills the subscription login, not credits.
    env = {k: v for k, v in os.environ.items()
           if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "16000"  # hard cap per response
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=900, env=env)
    if result.returncode != 0 and "--system-prompt" in (result.stderr or ""):
        # older CLI without --system-prompt: fold it into the prompt instead
        cmd = ["claude", "-p", f"[SYSTEM INSTRUCTIONS]\n{system}\n\n{prompt}",
               "--model", alias, "--output-format", "json", "--max-turns", "1"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=900, env=env)
    if result.returncode != 0:
        msg = (result.stderr or result.stdout)[:400]
        try:  # the CLI often wraps errors in JSON — surface the human-readable part
            data = json.loads(result.stdout)
            if data.get("is_error"):
                msg = str(data.get("result") or data.get("subtype") or msg)[:400]
        except (json.JSONDecodeError, TypeError):
            pass
        raise RuntimeError(f"Claude Code: {msg}")
    data = json.loads(result.stdout)
    if data.get("is_error"):
        raise RuntimeError(f"Claude Code: {str(data.get('result'))[:400]}")
    return str(data.get("result", "")), (data.get("usage") or {})


def _call(model: str, system: str, messages: list, max_tokens: int, label: str, attempt: int) -> str:
    """Make one LLM call via the active backend; record the complete exchange."""
    if _cycle["used"] >= CYCLE_BUDGET:
        raise BudgetExceeded(
            f"token budget exhausted ({_cycle['used']:,}/{CYCLE_BUDGET:,} after "
            f"{_cycle['calls']} calls) — refusing to make another LLM call this cycle. "
            f"Raise AGENT_TOKEN_BUDGET to allow more."
        )
    t0 = time.time()
    be = backend() or "api"
    if be == "claude_code":
        text, usage = _call_claude_code(model, system, messages)
    else:
        response = _get_client().messages.create(
            model=model,
            max_tokens=max_tokens,
            thinking={"type": "adaptive"},
            system=system,
            messages=messages,
        )
        text = next((b.text for b in response.content if b.type == "text"), "")
        usage = response.usage.model_dump()
    in_tokens = usage.get("input_tokens") or 0
    out_tokens = usage.get("output_tokens") or 0
    cache_write = usage.get("cache_creation_input_tokens") or 0
    cache_read = usage.get("cache_read_input_tokens") or 0
    _cycle["used"] += in_tokens + cache_write + out_tokens
    _cycle["calls"] += 1
    entry = {
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "label": label,
        "model": model,
        "backend": be,
        "attempt": attempt,
        "duration_s": round(time.time() - t0, 1),
        "input_tokens": in_tokens,
        "output_tokens": out_tokens,
        "cache_creation_input_tokens": cache_write,
        "cache_read_input_tokens": cache_read,
        "cycle_used": _cycle["used"],
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
