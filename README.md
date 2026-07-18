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
python -m pip install -r requirements.txt
```

## Run locally

Mock mode is deterministic and requires no API key:

```sh
AGENT_MOCK=1 python -m agent.webui
```

Open <http://localhost:8777>.

For Anthropic API mode, set `ANTHROPIC_API_KEY` and start the same module
without `AGENT_MOCK=1`. The agent can also use a signed-in Claude Code CLI when
it is available.

See [`agent/README.md`](agent/README.md) for the level format, gameplay details,
and architecture.
