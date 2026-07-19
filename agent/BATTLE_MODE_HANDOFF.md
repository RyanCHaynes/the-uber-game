# Battle Mode — Handoff / Status (for the next agent)

> Written just before a machine reboot. Read top to bottom. The code is DONE and
> correct on disk; the thing that blocked us was **environmental** (a stale server
> started by another tool), not a bug.

---

## TL;DR
- **Battle mode Phase 1 is fully implemented** on branch `bo-dev`, working-tree
  changes are **uncommitted**. Verified in mock tests (14/14 pass).
- **The blocker was NOT code.** The `webui` server the browser was hitting had
  been started by **Codex** in its own sandbox with *old* code, so `POST /api/mode`
  returned **404** and no battle arena was ever generated. User is rebooting to
  clear all stale servers.
- **After reboot:** start the server yourself from the project dir and hard-reload
  the browser. Verify `POST /api/mode` → **200** in DevTools before anything else.

---

## What we're building
A second game mode, **Battle**, alongside the existing **Adventure** mode:
- Fixed single-screen arena (≤30×15 tiles → camera auto-centers, no scroll), three
  platform elevations. Pure combat: **kill every enemy to win** (no exit to reach).
- Difficulty ramps each round via a mechanical controller (target `D`) that decides
  *when* to buff/create enemies; an LLM "Battle agent" picks *which* enemies to field.
- Decisions locked earlier: **shared bestiary** (battle buffs write to `enemies.json`),
  **all-at-once spawning** (Phase 1; timed waves = Phase 2), **soft respawn**,
  **controller + LLM picks**.

---

## What's DONE (on disk, branch `bo-dev`, uncommitted)
- **`agent/battle.py`** (NEW): `run_battle_cycle(round, prev_feedback)`,
  `_update_difficulty` (D controller), `difficulty_score`, `ARENA_TEMPLATE`
  (15×30, 3 platforms, S + nominal E), predefined spawn `_SLOTS`, `_heuristic_pick`
  (mock/fallback) + `_llm_pick`, buff/create triggers. Writes `level_NNN.csv` +
  `data/rounds/round_NNN/battle_design.json` + `data/battle_state.json`.
- **`agent/enemy_designer.py`**: added `harden_and_write()` + `SYSTEM_HARDEN` — the
  "make ONE enemy harder" lever, reusing `apply_patch` (±50%/round budget, clamps,
  rollback-safe). Writes `enemies.json`.
- **`agent/webui.py`**: `_state["mode"]`; `POST /api/mode` (`_handle_mode` — switching
  to battle generates the first arena immediately); `_handle_feedback` + mode-aware
  `_run_agent_cycle` branch adventure→`pipeline.run_cycle` vs battle→
  `battle.run_battle_cycle`; `_snapshot` adds `game_mode` + `battle_design`; `_reset`
  also clears `battle_state.json`.
- **`agent/web/index.html`**: ⚔ Adventure/Battle toggle (`battleEnabled`, ~line 851);
  `levelIsBattle` frozen at load (~547, in `loadPlayLevel`); **kill-all win** in
  `ptStep` (~907, guarded by `levelIsBattle`); `render()` syncs the toggle from
  `state.game_mode`.
- **`agent/llm.py`**: `CYCLE_BUDGET` raised 60000 → **100000**.
- (Earlier this session, already committed as `cbb4dac`: gamepad controls + aim
  reticle fixes.)

## Verified (mock, no browser/LLM)
- 14/14 checks: arena validates (15×30) for single + swarm, difficulty ramps up on
  trivial wins / eases on deaths, `_run_agent_cycle` battle route works,
  `harden_and_write` applies a harder+clamped enemy AND rolls back invalid patches.
- Adventure path untouched; `node --check` passes on the game script. **Real data
  never mutated** (tests redirect module paths to temp dirs).

## NOT yet verified (needs the real environment)
- **Live browser**: arena renders fixed with 3 platforms; kill-all pops the rating form.
- **LLM path** (needs `NVIDIA_API_KEY`): `_llm_pick`, `harden_and_write`,
  `maybe_add_entityspec`. Mock only exercises the heuristic pick.

---

## The blocker we hit (so you don't chase ghosts)
- Symptom: clicking ⚔ flashes the "designing" banner, then nothing changes.
- Cause: the browser was talking to a server **Codex** launched in its own sandbox
  with pre-battle-mode code → `/api/mode` 404s → no cycle runs. Proof: **no
  `data/battle_state.json` exists** and the newest level (`level_030.csv`) is a
  28-row *adventure* level (a battle arena is **15 rows**).
- Our shell couldn't see/kill it (`ps`/`curl` empty; different process + network
  namespace). We already killed one earlier stale server (PID 87964, from Jul 18).
- Git is fine: local `main` and `bo-dev` are at the **same commit**; our battle work
  is uncommitted working-tree changes on `bo-dev`.

## Immediate next steps AFTER reboot
1. `cd /mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game`
2. Start ONE server here (not via Codex): `python3 -m agent.webui`
   (or `AGENT_MOCK=1 python3 -m agent.webui` for the offline/heuristic path).
3. Hard-reload the browser (Ctrl-Shift-R). In DevTools → Network, confirm
   `POST /api/mode` returns **200** (not 404).
4. Click ⚔. Expect terminal: `[battle round N] difficulty target D=… / wrote
   level_NNN.csv (battle arena, D=…)`, and a 15-row arena to load. Kill all enemies
   → rating form appears.
5. **Commit the battle work to `bo-dev`** so it's safe from clobbering.

---

## Open design decision (was mid-discussion): cleaner mode separation
User felt the two modes are too entangled and wants a **cleaner, more discreet
separation**. Recommended refactor (NOT started):
- **Separate battle storage** (`data/battle/`) + its own round counter — stop sharing
  the `level_NNN.csv` namespace/counter with adventure.
- **Unified `GET /api/play`** returning `{mode, csv, round, difficulty}`; the frontend
  sets win rules from `payload.mode` — eliminates the `game_mode` freeze/race.
- **Feedback carries the played mode**, not a mutable global.
Two sub-choices to confirm with the user: (a) full decouple vs minimal patch;
(b) minimal battle status vs full browsable battle history. This is *optional* if the
fresh-server fix makes battle work, but recommended for robustness/debuggability.

---

## Gotchas / notes for next agent
- **Python doesn't hot-reload** — always restart `webui` after editing server code.
- **One server only** on :8777. Check stale ones: `ps aux | grep agent.webui`,
  `lsof -iTCP:8777 -sTCP:LISTEN`. Don't let another tool (Codex) also run one.
- **Don't run two coding agents on this repo at once** — they clobber each other.
- **`enemies.json` has already evolved** (5 enemies incl. 2 EntitySpec: `iron_moth`,
  `mech_moth`); don't assume the 3-enemy seed values.
- **Test pattern**: deep-copy the roster and redirect module path constants
  (`battle.LEVELS_DIR`, `enemy_designer.ROSTER_PATH`, etc.) to temp dirs so the real
  `enemies.json`/levels are never touched. Stub `enemy_designer._harden` / `_llm`
  calls to test without an API key.
- **Difficulty scale note**: `BASE_D=1.0` but the weakest enemy scores ~4, so the
  first few battles field one weakest enemy until `D` climbs past ~4. Tunable via
  `BASE_D` / `difficulty_score` in `agent/battle.py`.
