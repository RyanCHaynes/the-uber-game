# Game Design Agent

This repository contains an LLM-assisted game-design loop for a browser-based
platformer. Playtest feedback and telemetry are analyzed between rounds, useful
lessons are retained, and the next level is generated and validated before it
is made available to play.

## Setup

Requires Python 3.10 or newer.

```sh
python3 -m venv .venv
. .venv/bin/activate
```

## Run locally

Mock mode is deterministic and requires no API key:

```sh
AGENT_MOCK=1 python -m agent.webui
```

Open <http://localhost:8777>.

For NVIDIA Nemotron 3 Ultra 550B on NVIDIA's hosted NIM endpoint:

```sh
export NVIDIA_API_KEY="<your-key>"
python -m agent.webui
```

The backend, endpoint, model, temperature, reasoning mode, timeout, and token
budget are fixed in code. The only runtime setting is `NVIDIA_API_KEY`. The
hardcoded model is `nvidia/nemotron-3-ultra-550b-a55b` at NVIDIA's hosted
`integrate.api.nvidia.com` endpoint. Provider requests pass through a bounded
in-process queue and retry temporary capacity/rate-limit failures with backoff.
Never commit API keys.

Generated level plans are mechanically repaired before validation: bounds and
entity limits are enforced and overlapping entities are relocated. Remaining
reachability failures use a minimum-change connector path before another model
retry is considered.

The persistent lesson catalog records categories, evidence, confidence, and
application outcomes. Relevant memories are retrieved for each design, and
Nemotron performs event-driven semantic consolidation after meaningful memory
growth or likely duplication. All merged source knowledge remains auditable.

See [`agent/README.md`](agent/README.md) for the level format, gameplay details,
and architecture.
