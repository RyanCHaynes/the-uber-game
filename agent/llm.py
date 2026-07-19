"""Thin LLM wrapper — the only file that knows which provider we use.

Swapping providers later means reimplementing complete_json() here, nothing else.
"""

import datetime
import json
import os
import queue
import re
import threading
import time
from pathlib import Path
from urllib import error, request

LOG_PATH = Path(__file__).parent / "data" / "llm_log.jsonl"

# Hard token budget per agent cycle (analyst + designer + retries, all backends).
# Counts input + cache-creation + output. Once exhausted, further LLM calls in
# the cycle raise instead of running — the round fails cleanly and cheaply.
CYCLE_BUDGET = 100000
_cycle = {"used": 0, "calls": 0}


def reset_cycle_usage():
    _cycle["used"] = 0
    _cycle["calls"] = 0


def cycle_usage() -> dict:
    return {"used": _cycle["used"], "calls": _cycle["calls"], "budget": CYCLE_BUDGET}


class BudgetExceeded(RuntimeError):
    pass


def backend() -> str | None:
    """NVIDIA hosted NIM is available when its API key is present."""
    return "nvidia" if os.environ.get("NVIDIA_API_KEY") else None


NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b"
NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_RETRY_DELAYS = (5, 15, 30, 60, 120)
NVIDIA_QUEUE_MAX = 16
ANALYST_MODEL = NVIDIA_MODEL
DESIGNER_MODEL = NVIDIA_MODEL

_request_queue = queue.Queue(maxsize=NVIDIA_QUEUE_MAX)
_worker_lock = threading.Lock()
_worker_started = False
_queue_state_lock = threading.Lock()
_queue_state = {
    "active": False,
    "attempt": 0,
    "max_attempts": len(NVIDIA_RETRY_DELAYS) + 1,
    "retry_at": 0.0,
}


class _NvidiaJob:
    def __init__(self, model, system, messages, max_tokens, json_mode):
        self.args = (model, system, messages, max_tokens, json_mode)
        self.done = threading.Event()
        self.result = None
        self.error = None


class _NvidiaRequestError(RuntimeError):
    def __init__(self, message: str, retryable: bool, retry_after: float | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.retry_after = retry_after


def queue_status() -> dict:
    """Return safe queue/retry state for the dashboard."""
    with _queue_state_lock:
        state = dict(_queue_state)
    retry_in = max(0, round(state.pop("retry_at") - time.time()))
    return {**state, "queued": _request_queue.qsize(), "retry_in": retry_in}


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


def _nvidia_error_message(body: bytes, fallback: str) -> str:
    try:
        payload = json.loads(body.decode("utf-8", errors="replace"))
        api_error = payload.get("error") or {}
        if isinstance(api_error, dict) and api_error.get("message"):
            return str(api_error["message"])[:400]
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    return fallback[:400]


def _retry_after_seconds(headers) -> float | None:
    if not headers:
        return None
    value = headers.get("Retry-After")
    try:
        return min(300.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return None


def _send_nvidia_request(
    model: str,
    system: str,
    messages: list,
    max_tokens: int,
    json_mode: bool = False,
) -> tuple[str, dict]:
    """Call NVIDIA's hosted OpenAI-compatible chat completions endpoint."""
    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        raise _NvidiaRequestError(
            "NVIDIA_API_KEY is required for the NVIDIA backend", retryable=False
        )

    payload = {
        "model": NVIDIA_MODEL,
        "messages": [{"role": "system", "content": system}, *messages],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "reasoning_effort": "none",
        "stream": False,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    req = request.Request(
        NVIDIA_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=900) as response:
            data = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as err:
        body = err.read()
        message = _nvidia_error_message(body, f"HTTP {err.code}: {err.reason}")
        lower_message = message.lower().replace("_", " ")
        retryable = err.code in {429, 500, 502, 503, 504} or any(
            marker in lower_message
            for marker in (
                "resourceexhausted",
                "resource exhausted",
                "worker local total request limit",
                "rate limit",
                "temporarily unavailable",
                "overloaded",
            )
        )
        raise _NvidiaRequestError(
            f"NVIDIA: {message}",
            retryable=retryable,
            retry_after=_retry_after_seconds(err.headers),
        ) from err
    except error.URLError as err:
        raise _NvidiaRequestError(f"NVIDIA: {err.reason}", retryable=True) from err
    except (json.JSONDecodeError, UnicodeDecodeError) as err:
        raise RuntimeError("NVIDIA returned an invalid JSON response") from err

    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as err:
        message = _nvidia_error_message(
            json.dumps(data).encode("utf-8"), "response contained no completion"
        )
        raise RuntimeError(f"NVIDIA: {message}") from err
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("NVIDIA returned an empty completion")

    raw_usage = data.get("usage") or {}
    usage = {
        "input_tokens": raw_usage.get("prompt_tokens") or 0,
        "output_tokens": raw_usage.get("completion_tokens") or 0,
    }
    return text, usage


def _send_with_backoff(*args) -> tuple[str, dict]:
    max_attempts = len(NVIDIA_RETRY_DELAYS) + 1
    for index in range(max_attempts):
        attempt = index + 1
        with _queue_state_lock:
            _queue_state.update(attempt=attempt, retry_at=0.0)
        try:
            text, usage = _send_nvidia_request(*args)
            usage["provider_attempts"] = attempt
            return text, usage
        except _NvidiaRequestError as err:
            if not err.retryable or index == len(NVIDIA_RETRY_DELAYS):
                if err.retryable:
                    raise RuntimeError(
                        f"{err} (temporary failure persisted after {attempt} attempts)"
                    ) from err
                raise
            delay = err.retry_after
            if delay is None:
                delay = NVIDIA_RETRY_DELAYS[index]
            with _queue_state_lock:
                _queue_state["retry_at"] = time.time() + delay
            print(
                f"  NVIDIA capacity unavailable; request remains queued — "
                f"retry {attempt + 1}/{max_attempts} in {delay:g}s"
            )
            time.sleep(delay)


def _nvidia_worker():
    while True:
        job = _request_queue.get()
        with _queue_state_lock:
            _queue_state.update(active=True, attempt=0, retry_at=0.0)
        try:
            job.result = _send_with_backoff(*job.args)
        except Exception as err:
            job.error = err
        finally:
            with _queue_state_lock:
                _queue_state.update(active=False, attempt=0, retry_at=0.0)
            job.done.set()
            _request_queue.task_done()


def _ensure_worker():
    global _worker_started
    with _worker_lock:
        if not _worker_started:
            threading.Thread(
                target=_nvidia_worker, name="nvidia-request-queue", daemon=True
            ).start()
            _worker_started = True


def _call_nvidia(
    model: str,
    system: str,
    messages: list,
    max_tokens: int,
    json_mode: bool = False,
) -> tuple[str, dict]:
    """Queue one NVIDIA request and wait for its bounded retry sequence."""
    _ensure_worker()
    job = _NvidiaJob(model, system, messages, max_tokens, json_mode)
    try:
        _request_queue.put_nowait(job)
    except queue.Full as err:
        raise RuntimeError(
            f"NVIDIA request queue is full ({NVIDIA_QUEUE_MAX} pending requests)"
        ) from err
    job.done.wait()
    if job.error is not None:
        raise job.error
    return job.result


def _call(
    model: str,
    system: str,
    messages: list,
    max_tokens: int,
    label: str,
    attempt: int,
    json_mode: bool = False,
) -> str:
    """Make one LLM call via the active backend; record the complete exchange."""
    if _cycle["used"] >= CYCLE_BUDGET:
        raise BudgetExceeded(
            f"token budget exhausted ({_cycle['used']:,}/{CYCLE_BUDGET:,} after "
            f"{_cycle['calls']} calls) — refusing to make another LLM call this cycle. "
            "The hardcoded cycle limit prevents another call."
        )
    t0 = time.time()
    be = backend()
    if be is None:
        raise RuntimeError("NVIDIA_API_KEY is not configured")
    text, usage = _call_nvidia(model, system, messages, max_tokens, json_mode)
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
        "provider_attempts": usage.get("provider_attempts", 1),
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
        text = _call(
            model, system, messages, max_tokens, label, attempt + 1, json_mode=True
        )
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
