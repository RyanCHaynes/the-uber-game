# Game Design Agent

An LLM agent that redesigns the game between rounds to make it more fun. You
playtest a level in the browser; your rating, comment, and telemetry (time,
falls, fall locations) go to the agent, which extracts design lessons, saves
standout levels to a library, and generates the next level — validated before
it ever reaches the game.

## Run it

From the `uber-game` directory:

```bash
# Offline — no API key needed (rule-based mock analyst/designer)
AGENT_MOCK=1 python3 -m agent.webui

# Real LLM mode (Claude)
export ANTHROPIC_API_KEY=sk-ant-...
python3 -m agent.webui
```

Then open http://localhost:8777. Mock mode is used automatically when no API
key is set.

**The loop:** play the level (arrows/WASD + space, R to restart) → finish (or
"End run & rate") → pick a star rating and leave a comment → the agent analyzes
and designs → the next level loads into the game automatically.

## Level format

Levels are CSV tile grids in `data/levels/level_NNN.csv` — one row per line,
comma-separated. `X` solid block · `.` empty · `S` spawn (one) · `E` exit (one).
Tiles are 32px; row 0 is the top.

## Architecture

```
web/index.html   playable platformer + dashboard (map, feedback, lessons, log)
     |  POST /api/feedback  (rating, comment, time, falls, fall locations)
webui.py         writes data/rounds/round_NNN/feedback.json, runs the cycle
     |
analyst.py       playtest -> diagnosis, lessons, fun score      (LLM call 1)
store.py         lessons -> data/store/lessons.json (deduped)
                 standout levels -> data/library/levels/
designer.py      diagnosis + lessons + library -> next CSV      (LLM call 2)
csv_level.py     parse + validate: structure, exactly one S/E, exit standable,
                 spawn has ground, exit reachable under jump physics
                 (MAX_JUMP_DX/MAX_JUMP_UP — keep in sync with the JS physics)
pipeline.py      orchestrates a cycle; writes data/levels/level_NNN.csv
                 + next_level.ready marker
```

`llm.py` is the only file that knows the provider — swap LLMs by rewriting
`complete_text()`/`complete_json()` there. `mock.py` mirrors the
analyst/designer interfaces with deterministic rules for offline testing.
