# Enemy Designer — Integration Plan

Plan for folding an adaptive **Enemy Designer** sub-agent into the main
between-rounds pipeline, alongside the existing Level Designer and Object
Designer. Written to be implemented in a fresh session; read it top to bottom
before starting.

---

## 1. Goal

Give the agent a specialist that **owns enemy definitions and adapts them
between rounds** from playtest feedback — the enemy analogue of what
`object_designer.py` already does for scene objects. The Level Designer keeps
owning geometry and *placement*; the Enemy Designer owns *what each enemy is*
and how it evolves.

Concretely, after each playtest the Enemy Designer should be able to:

1. Decide whether to introduce a new enemy archetype (rare) or adapt existing
   ones (common), or do nothing.
2. Emit small, validated edits (a **patch**) against the current roster.
3. Never ship an invalid enemy, and always keep the last-good roster (rollback).

---

## 2. Current state (verified in code)

**The between-rounds cycle** (`agent/pipeline.py::run_cycle`) already runs
several LLM roles in sequence, each guarded so it can never block the next
level:

```
feedback.json → Analyst → lessons/consolidation
                       → Object Designer.propose  (maybe add 1 object type)
                       → Level Designer.design    (geometry + enemy placement by digit)
                       → Object Designer.place_objects (separate game-file pass)
                       → validate → write level_NNN.csv
```

- Roles run only when `brain == "llm"` (see `_get_brains`); mock mode skips them.
- Shared LLM wrapper `llm.complete_json(...)`, models `llm.DESIGNER_MODEL` /
  `llm.ANALYST_MODEL`, per-cycle token budget `llm.CYCLE_BUDGET` (60k).

**`object_designer.py` is the template to copy.** It gives us, already working:
- a persistent **catalog** (`data/objects.json`) of designed types;
- `propose()` → add at most one new type per round, empty when the catalog
  suffices; `apply_proposals()` → validate against safe templates + append;
- a role-specific **lesson store** (`data/store/object_lessons.json`) with its
  own `add_lessons` / `relevant_lessons` / `format_lessons`;
- a validate → retry → **failure-to-lesson** loop
  (`record_validation_failures`, `mark_failures_resolved`);
- everything wrapped in `try/except` in the pipeline.

**Enemy data today** (`data/enemies.json`, served at `/api/enemies`, consumed by
the shipped game in `agent/web/index.html`):

```jsonc
{ "id":"wasp", "name":"Wasp", "desc":"...",
  "parts":[ {"id":"body","shape":"circle","r":10,"color":"#c792ea",
             "offset":{"x":0,"y":0},"vulnerable":true,"hp":15}, ... ],
  "movement":{ "type":"flyer", "speed":55, "range":110, "bob":22, "bob_hz":0.9 },
  "attack":{ "type":"shoot", "cooldown_s":1.8, "speed":4.5, "damage":1,
             "range":380, "gravity":0, "color":"#c792ea" },
  "contact_damage":1 }
```

- The roster is an **array; index+1 is the CSV digit** (`1`–`9`) the Level
  Designer places. `roster_summary()` feeds `digit: name — desc` into the
  designer prompt. `csv_level.MAX_ENEMIES = 24` instances; up to 9 archetypes.
- Movement vocab: `patrol | stationary | flyer`. Attack vocab:
  `none | lob | shoot`. Parts are `rect|circle|tri` with independent
  `hp`/`vulnerable`. The game engine (`updateEnemies`/`updateShots`/`partHit`)
  hard-codes this schema.
- `_reset()` wipes `store/`, `library/`, `levels/`, `rounds/` but **not**
  `enemies.json`/`objects.json` — catalogs are persistent by design.

**Our EntitySpec system** (`agent/entity/`) is richer than the shipped format:
components, `brain` states with parallel `tracks`, emitters/patterns, an
expression language, ~10 motion controllers, events/signals. It has a validator
(`schema.validate`), a generator (`generator.generate`, `SYSTEM`, `MODEL`), and
a **working runtime interpreter** in `agent/entity/web/index.html` (the SIM
module) — but only the standalone workshop runs it. **The shipped game cannot
execute an EntitySpec.**

---

## 3. The pivotal decision — enemy format

This is the one fork that reshapes everything. **DECISION (confirmed): phased
A → B** — ship the adaptive loop in the simple format first (Phase 1), then port
the EntitySpec interpreter into the game for bosses (Phase 2). The comparison
below is kept for context.

| | **A. Simple format** | **B. EntitySpec native** | **C. EntitySpec + compile-down** |
|---|---|---|---|
| Enemy Designer authors | current `enemies.json` schema | full EntitySpec | full EntitySpec |
| Game engine change | none | port SIM interpreter into `web/index.html` | none yet (compiler bridges) |
| Bosses / phases / brains | ✗ | ✓ | ✗ (lossy downshift) |
| Risk to running game | none | high | low |
| Reuses `agent/entity/` | schema ideas only | schema + validator + generator + interpreter | schema + validator + generator |

**Recommendation: phased A → B.**
- **Phase 1 ships the adaptive *loop* in the simple format** — the actual point
  of a between-rounds agent (enemies that change with feedback), against the
  game that already runs, at near-zero risk.
- **Phase 2 upgrades the format to EntitySpec** by porting the interpreter we
  already wrote and tested, unlocking real bosses.

This sequences risk correctly and wastes nothing: `agent/entity/schema.py`,
`generator.py`, and the SIM interpreter are the Phase 2 destination. Option C is
explicitly *not* recommended — the compiler is nontrivial and throwaway.

> If you'd rather go straight to EntitySpec, skip to Phase 2 first; the Phase 1
> agent scaffolding (Section 5) is written to be format-agnostic, so only the
> validator/patch-target details change.

The rest of this plan assumes the phased path.

---

## 4. Target architecture

Enemy Designer sits as a **sibling role** in `run_cycle`, mirroring the Object
Designer, sharing the analyst diagnosis + feedback and the token budget:

```
Analyst → diagnosis + combat signal (kills, hits_taken, deaths, comment)
   ├── Object Designer  (scene objects)
   ├── Enemy Designer   (NEW)
   │      propose_archetype?  → maybe add 1 archetype to the roster
   │      adapt_roster        → EnemyPatch over existing archetypes
   │      validate → rollback-safe write to enemies.json
   └── Level Designer   (geometry + places enemies by digit, reads roster_summary)
```

**Role split (unchanged principle):** Level Designer places enemies by digit and
never edits their definitions; Enemy Designer edits definitions and never places
them. The shared contract is `roster_summary()` (already feeds the Level
Designer). No analyst change required for Phase 1 — combat signals already exist
in `feedback.players[0]` (`enemies_killed`, `hits_taken`, `deaths`, `comment`).

---

## 5. Phase 1 — Enemy Designer agent (simple format)

New module `agent/enemy_designer.py`, structured as a near-copy of
`object_designer.py`. Everything below mirrors an existing, working pattern.

### 5.1 Catalog + roster (reuse existing file)
- Read/write `data/enemies.json` (the array is the catalog).
- `load_roster()`, `roster_summary()` (can replace `pipeline.roster_summary()`),
  `MAX_ARCHETYPES = 9` (CSV digit ceiling), a set of the “safe” movement/attack
  templates the **engine actually supports** (`patrol/stationary/flyer`,
  `none/lob/shoot`) — the closed vocabulary the model may use.

### 5.2 Add-an-archetype path (`propose` / `apply_proposals`)
- `propose(analysis, feedback, lessons_text)` → ask Nemotron whether a genuinely
  new archetype is warranted; at most one per round; empty when roster suffices.
  Same prompt shape and `max_tokens≈2500` as `object_designer.propose`.
- `apply_proposals(proposals, round)` → validate every field against the safe
  template (clamp numbers with a `_safe_number` helper, whitelist
  movement/attack types, sanitize colors, cap parts/hp), assign the next free
  digit, append to `enemies.json`, append to a design log
  (`data/store/enemy_design_log.jsonl`). Refuse if roster is full.

### 5.3 Adapt-existing path (`adapt` — the core value)  ← the between-rounds loop
This is the `BossPatch` idea from `llm_adaptive_boss_system_plan.md` §2/§11/§12,
scaled to the simple schema.
- `adapt(analysis, feedback, roster, lessons_text, change_budget)` → Nemotron
  returns a compact **EnemyPatch**:
  ```json
  { "note": "wasp stingers too fast to dodge; player liked shooting them",
    "ops": [ ["mul","wasp.attack.speed",0.8],
             ["set","wasp.attack.cooldown_s",2.2],
             ["add","wasp.parts.body.hp",5] ] }
  ```
- Patch grammar: `["set"|"add"|"mul", "<archetypeId>.<dot.path>", value]`,
  targeting **stable ids** (archetype `id`, part `id`), never array indices.
- `apply_patch(roster, patch)` → resolve dotted paths, apply ops, then run
  `validate_roster()` (Section 7). Enforce a **change budget** (max ops, max
  numeric delta, structural changes off by default) per plan §11.

### 5.4 Role lessons + failure→lesson loop
- `data/store/enemy_lessons.json` with its own `add_lessons` /
  `relevant_lessons` / `format_lessons` (copy from `object_designer`).
- On validation failure, convert errors to deduplicated persistent rules
  (`record_validation_failures`) and feed them back on retry
  (`mark_failures_resolved` on success). Copy the `FAILURE_RULES` pattern.

### 5.5 Pipeline wiring (`agent/pipeline.py::run_cycle`)
Add, after the Object Designer proposal block and gated on `brain == "llm"`,
wrapped in `try/except` (never block the level):

```python
from . import enemy_designer
if brain == "llm":
    print("  evaluating enemy roster (enemy designer)...")
    try:
        roster = enemy_designer.load_roster()
        added = enemy_designer.apply_proposals(
            enemy_designer.propose(analysis, feedback,
                enemy_designer.format_lessons(
                    enemy_designer.relevant_lessons(memory_query))),
            round_number)
        enemy_designer.adapt_and_write(analysis, feedback, round_number)  # rollback-safe
    except Exception as err:
        print(f"  enemy designer skipped after error: {err}")
```

- `roster_summary()` (already consumed by `design(...)`) now reflects the
  updated roster automatically, so the Level Designer places the evolved
  enemies with no further change.

### 5.6 Mock mode
- Follow `object_designer`: LLM-only. In mock, the roster is untouched (the
  three seed enemies keep working). Optionally add a tiny deterministic
  `mock.adapt` later; not required for Phase 1.

---

## 6. Phase 2 — EntitySpec in the game (unlock bosses)

**Implemented (2026-07-18).** The shared runtime now lives at
`agent/web/entity_runtime.js` and is served by both web apps. The main game
dispatches legacy and EntitySpec roster entries, runs EntitySpecs in CSV world
coordinates, supports a single-instance boss digit with an exit lock, and feeds
damage/kills into existing telemetry. The Enemy Designer validates mixed
rosters with `schema.validate`, applies stable-ID EntitySpec patches, performs a
headless activation gate before writes, and can invoke the EntitySpec generator
for explicit new-enemy/boss requests. The Iron Moth at roster digit 4 is the
initial native boss and legacy entries remain supported during migration.

Only after Phase 1 is stable. This is the largest piece; budget it separately.

1. **Extract the interpreter.** Pull the SIM module out of
   `agent/entity/web/index.html` into a shared JS file (e.g.
   `agent/web/entity_runtime.js`) that both the workshop and the main game load.
   Keep the standalone workshop as the R&D/test bed.
2. **Run EntitySpec in world space.** The workshop uses a fixed 24×13 arena; the
   game uses a scrolling camera over a CSV tile level. Adapt the runtime to the
   game’s world/camera coordinates and its existing player controller (already
   the same constants). Reconcile collision against the CSV grid.
3. **Roster format migration.** Move `enemies.json` entries to EntitySpec
   (validated by `agent/entity/schema.py`). Support both during transition: a
   roster entry is either legacy-simple or an EntitySpec; the game dispatches on
   shape. Legacy `updateEnemies` stays until all archetypes migrate.
4. **Enemy Designer authors EntitySpec + EntityPatch.** Swap the Phase 1
   generator for `agent/entity/generator.py` and validate with
   `schema.validate`; patches target EntitySpec stable ids (already the design
   in the boss plan).
5. **Boss placement semantics.** A boss is one large multi-part entity placed
   once, not a type spammed 24×. Decide: a reserved digit for “the boss,” or a
   separate boss-rush mode. Out of scope for the roster-of-9 model; note as a
   follow-up.
6. **Dry-run before activate** (plan §10.5): instantiate the new EntitySpec
   headlessly (the workshop harness already does this) and confirm it can act
   and take damage before writing it live.

---

## 7. Validation, safety, rollback (both phases)

- **Structural validator.** Phase 1: a `validate_roster()` checking types,
  numeric ranges, unique ids/digits, part graphs, whitelisted movement/attack.
  Phase 2: reuse `agent/entity/schema.validate` verbatim.
- **Rollback (plan §10.6).** Before writing `enemies.json`, keep the current
  file as the last-good copy (e.g. `data/store/enemies_last_good.json`). If a
  patch fails validation after retries, **reject and keep the previous roster.**
  Never leave the game without a valid roster.
- **Change budget / anti-oscillation (plan §11–12).** Cap ops per round and
  per-archetype numeric drift; keep a short recent-changes history in the role
  lessons so the model doesn’t undo last round’s fix.
- **Token budget.** Each call stays lean (patch ops, not full roster rewrites) —
  respect `llm.CYCLE_BUDGET`; the patch approach is deliberately cheap.

---

## 8. File-by-file change list

**New**
- `agent/enemy_designer.py` — the role (Sections 5, 7). Mirror
  `object_designer.py`.
- `data/store/enemy_lessons.json`, `data/store/enemy_design_log.jsonl` —
  created on first write.
- (Phase 2) `agent/web/entity_runtime.js` — shared interpreter.

**Edit**
- `agent/pipeline.py` — add the guarded Enemy Designer block (5.5); optionally
  delegate `roster_summary()` to `enemy_designer`.
- `agent/webui.py` — `/api/enemies` already serves the roster; add
  `enemy_design.json` to the round snapshot if you want it in the dashboard;
  decide whether `_reset()` should also restore the seed roster (recommend: add
  a “reset enemies to seed” option, off by default, matching objects).
- (Phase 2) `agent/web/index.html` — dispatch legacy vs EntitySpec enemies;
  load `entity_runtime.js`.
- `agent/entity/generator.py` — reused as the Phase 2 author (already built).

**Reuse as-is**
- `agent/entity/schema.py` (Phase 2 validator), `agent/entity/web/index.html`
  SIM (source for the ported runtime + dry-run harness),
  `store.save_to_library("enemies", ...)` (already supports the `enemies` kind
  for keeping standout enemies).

---

## 9. Open questions to confirm before/while implementing

1. **Format path** — ✅ decided: phased A→B (Section 3).
2. **Adaptation scope** — should Phase 1 adapt every round, or only when the
   diagnosis/feedback implicates enemies (fewer tokens, less oscillation)?
   Recommend: only when combat signal is present (kills/hits/deaths/comment
   mention enemies).
3. **Reset semantics** — should `_reset()` restore the seed roster, or keep
   evolved enemies across resets (as objects do today)? Recommend: keep evolved,
   add an explicit “reset enemies” control.
4. **Analyst extension** — Phase 1 reads raw feedback; do we later add an
   enemy-specific diagnosis field to the Analyst output? Optional.
5. **Boss placement** (Phase 2) — reserved digit vs dedicated boss-rush mode.

---

## 10. Suggested first session (smallest shippable slice)

1. `agent/enemy_designer.py` with `load_roster` / `roster_summary` /
   `validate_roster` / rollback write, plus `adapt()` (patch author) and
   `apply_patch()`. Skip `propose` (new archetypes) initially.
2. Wire the guarded `adapt` call into `run_cycle` behind `brain == "llm"`.
3. Manually run one cycle against a saved `feedback.json` and confirm: a valid
   `enemies.json` patch applies, an invalid one rolls back, and the Level
   Designer places the adapted enemies unchanged.
4. Then add `propose`/`apply_proposals` (new archetypes) and the role-lesson
   failure loop.

That delivers the adaptive-enemy loop end-to-end in the running game before any
engine work, and leaves EntitySpec/bosses (Phase 2) as a clean, separate upgrade
built on the interpreter we already have.
