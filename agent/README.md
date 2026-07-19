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

# Real LLM mode (NVIDIA hosted NIM, Nemotron 3 Ultra 550B)
export NVIDIA_API_KEY=nvapi-...
python3 -m agent.webui
```

Then open http://localhost:8777. Mock mode is used automatically when no API
key is set.

**The loop:** play the level (arrows/WASD + space, R to restart) → finish (or
"End run & rate") → pick a star rating and leave a comment → the agent analyzes
and designs → the next level loads into the game automatically.

## Level format

Levels are CSV tile grids in `data/levels/level_NNN.csv` — one row per line,
comma-separated. `X` solid block · `.` empty · `S` spawn (one) · `E` exit (one)
· digits `1`-`9` place an enemy of that type (max 24). Tiles are 32px; row 0 is
the top.

## Combat

The player aims with the mouse (trajectory preview + crosshair) and left-clicks
to lob a gravity-arcing projectile. 3 hearts, brief invulnerability after a hit;
dying respawns at S and counts as a death.

Enemy types live in `data/enemies.json` — agent-editable JSON. A roster entry
may use the legacy schema or native EntitySpec. Legacy entries have:
`parts` (colored shapes — rect/circle/tri — positioned by `offset`, optionally
attached to a `parent` part; each part is `vulnerable` with `hp`, or armored and
blocks shots), `movement` (`stationary` | `patrol` | `flyer` with speed/range/bob),
`attack` (`none` | `lob` | `shoot` — projectile speed, cooldown, range, gravity),
and `contact_damage`. An enemy dies when all its vulnerable parts are destroyed.

EntitySpec entries support nested damageable parts, reusable projectile/summon
definitions, motion controllers, parallel brain tracks, state transitions,
emitters, events, and signals. `web/entity_runtime.js` runs these definitions in
the main scrolling world and in the standalone workshop. A boss digit is a
single encounter marker even if repeated in the CSV, and the level exit remains
locked until that boss is defeated. The shipped Iron Moth is roster digit `4`.

## Architecture

```
web/index.html   playable platformer + dashboard (map, feedback, lessons, log)
entity_runtime.js shared EntitySpec interpreter (game + entity workshop)
     |  POST /api/feedback  (rating, comment, time, falls, fall locations)
webui.py         writes data/rounds/round_NNN/feedback.json, runs the cycle
     |
analyst.py       playtest -> diagnosis, lessons, fun score      (LLM call 1)
store.py         lessons -> data/store/lessons.json (deduped)
                 standout levels -> data/library/levels/
designer.py      diagnosis + lessons + library -> JSON plan -> compiled next CSV
csv_level.py     parse + validate: structure, exactly one S/E, exit standable,
                 spawn has ground, exit reachable under jump physics
                 (MAX_JUMP_DX/MAX_JUMP_UP — keep in sync with the JS physics)
pipeline.py      orchestrates a cycle; writes data/levels/level_NNN.csv
                 + next_level.ready marker
enemy_designer.py validates/adapts mixed rosters; generates EntitySpecs on demand
```

`llm.py` is the only file that knows the provider. Production calls always use
NVIDIA's hosted `nvidia/nemotron-3-ultra-550b-a55b` endpoint. All request
settings are fixed in code; only `NVIDIA_API_KEY` comes from the environment.
Without a key, the pipeline uses its deterministic mock fallback.
NVIDIA calls are serialized through an in-process queue. Temporary capacity,
rate-limit, and upstream failures retry after 5, 15, 30, 60, and 120 seconds
(or NVIDIA's `Retry-After` value); authentication and validation errors fail
immediately.

The designer never asks the model to count or emit raw grid characters. The
model returns a compact JSON plan of solid rectangles and entity coordinates;
Python compiles it into the exact tile grid and runs the reachability validator.
Before validation, Python safely clips off-by-one rectangles, enforces entity
limits, and relocates overlapping spawn, exit, and enemy cells. If reachability
fails, a minimum-change path search connects existing terrain with the fewest
practical edits and relocates displaced enemies. Any remaining failure sends the
repaired previous plan plus exact validator errors back to the model.

## Persistent memory

Lessons use a structured catalog with stable IDs, categories, applicability
conditions, outcomes, confidence, evidence rounds, and application results. The
dashboard shows the full catalog, while each design receives only the 12 lessons
most relevant to its diagnosis and player feedback.

Memory consolidation is event-driven rather than time-based. After feedback adds
new knowledge, consolidation runs only when the catalog has materially grown,
contains likely overlap, or has become large. Nemotron identifies genuinely
redundant causal lessons; Python validates its ID groups, retains the canonical
lesson, and preserves every merged source in `merged_from` and the append-only
`data/store/consolidation_log.jsonl` audit log. Consolidation failures never block
level delivery. Each retrieved lesson is also linked to the generated round and
later player rating so the system can measure whether applying it succeeded.
