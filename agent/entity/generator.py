"""Turn a natural-language description into a validated EntitySpec.

Uses the shared ``agent.llm`` wrapper, so this tool runs on exactly the same
NVIDIA Nemotron endpoint, model, retry/queue behavior, and token log as the
main design agent. Mock mode (``AGENT_MOCK=1``) returns a deterministic spec so
the workshop is usable without an API key.
"""

import os

from .. import llm
from . import schema

MODEL = llm.DESIGNER_MODEL
MAX_ATTEMPTS = 3


def _use_mock() -> bool:
    if os.environ.get("AGENT_MOCK") == "1":
        return True
    return llm.backend() is None


SYSTEM = f"""You are the Entity Designer for a 2D side-view action game. You author
enemies and multi-part bosses as data. Return ONLY one JSON object — an EntitySpec.
Never write engine code, prose, markdown, or code fences.

Governing principle: you have a CLOSED vocabulary of verbs but free composition.
Everything is an entity — bodies, arms, weapons, projectiles, and summons all use
the same format. A projectile is just an entity with a visual, body, motion, and
contact damage. Compose freely; never invent components, motions, patterns, events,
or actions outside the lists below.

EntitySpec shape:
{{
  "v": 1,
  "id": "<snake_case id>",
  "name": "<display name>",
  "kind": "enemy" | "boss",
  "limits": {{"maxAlive": <int>, "maxSpawnsPerSecond": <int>, "maxSpawnDepth": <int>}},
  "vars": {{ "<name>": <number> }},
  "defs": {{ "<templateId>": <entity> }},
  "root": <entity>,
  "brain": {{ "start": "<stateId>", "states": {{ "<stateId>": <state> }} }}
}}

An entity is any combination of:
  "id", "tags": [..], "at": [x, y] (offset from parent, world units),
  "visual": {{"shape": <shape>, "size": [w, h], "tint": "#rrggbb"}},
  "body": {{"shape": <shape>, "size": [w, h] | "radius": <n>, "gravity": <0|1>}},
  "health": {{"max": <positive number>}},
  "motion": {{"type": <motion>, ...args}},
  "contact": {{"damage": <n>, "destroySelf": <bool>, "knockback": <n>}},
  "emitters": {{ "<name>": {{"at": [x,y], "ref": "<templateId>", "pattern": <pattern>}} }},
  "children": [ <entity>, ... ],
  "on": {{ "<event>": [ {{"<action>": {{...}}}} ] }},
  "life": {{"ttl": <positive seconds>}},
  "link": {{"parent": "<id>", "onParentDeath": "destroy|detach|disable"}}

A state is {{"tracks": [ {{"id", "loop": <bool>, "steps": [ {{"<action>": {{...}}}} ]}} ],
"transitions": [ {{"when": "<expr>", "to": "<stateId>"}} ]}}.

Closed vocabulary — use ONLY these:
  shapes:   {sorted(schema.SHAPES)}
  motion:   {sorted(schema.MOTIONS)}
  patterns: {sorted(schema.PATTERNS)}
  events:   {sorted(schema.EVENTS)}
  actions:  {sorted(schema.ACTIONS)}

Hard rules (validated automatically; violations cost a retry):
- Every id is unique across defs, root, and all children.
- Every emitter "ref" and every spawn "ref" must match a defs key or an entity id.
- Every brain transition "to" must be a defined state; "start" must be a real state.
- kind "boss" must include a "limits" block. Max nesting depth is {schema.MAX_CHILDREN_DEPTH};
  at most {schema.MAX_TOTAL_ENTITIES} entities total.
- health.max and life.ttl must be positive.

Where behavior goes (critical — the #1 mistake):
- ALL timed/sequenced behavior — waiting, telegraphing, firing volleys, moving —
  goes in a brain state's tracks[].steps. A looping track (loop:true) repeats its
  steps forever; that is how an enemy keeps attacking. NEVER leave a state's only
  track with "steps": []. If a state should attack, its track must contain the
  telegraph/fire/wait steps.
- Use a state's "enter": [...] for one-time setup when a state begins.
- "on" handlers are for INSTANTANEOUS reactions only (signal, spawn, set/add/mul,
  destroy, detach). NEVER put "wait", multi-step sequences, or a full attack inside
  an "on" handler — put those in a track.
- A transition "when" is a boolean expression, evaluated every frame. Valid terms:
  self.hpPct, distance(self, player), arena.time, timer (seconds spent in the
  current state), playerNear, playerFar, playerAbove, playerBelow,
  countAlive('tag:x'), alive('id'), and numeric comparisons / && / ||. Do NOT
  invent bare words like "attacking" or reference vars that do not exist.
- To make a simple enemy attack, give its root a brain with one looping track that
  telegraphs, fires an emitter, and waits — do not rely on events to start attacks.

Design guidance:
- A simple "enemy" is usually a single root entity with a body, health, one motion,
  contact damage, and maybe one emitter firing a projectile def.
- A "boss" has destructible children (wings, masks, arms), projectile/summon defs,
  and a brain with phases. Give parts independent health and signals so destroying
  one changes the fight.
- Keep the spec sparse; omit anything that should take a default. Size units are
  roughly tiles (player ~1 wide).
- Flying enemies set "body": {{..., "gravity": 0}}. Solid tiles/platforms BLOCK flyers
  now, so give them open airspace to move in; ground enemies use "gravity": 1.
- Player-seeking motions ("chase", "home", "hover", "orbit") take a "range" in tiles —
  the awareness radius. The enemy only pursues the player within that range and returns
  to its post otherwise. Use a small value (roughly 5-9 tiles); do NOT let enemies chase
  from across the whole level. Fired projectile defs (velocity/home missiles) omit range
  and always fly toward their target.

Worked example of a correct attacking enemy — imitate this structure (attack lives
in a LOOPING track, not in an event):
{{
  "v": 1, "id": "spitter", "name": "Spitter", "kind": "enemy",
  "defs": {{ "glob": {{ "id": "glob", "tags": ["projectile", "enemy"],
    "visual": {{"shape": "circle", "size": [0.3, 0.3], "tint": "#8bd450"}},
    "body": {{"shape": "circle", "radius": 0.15, "gravity": 0}},
    "motion": {{"type": "velocity", "speed": 8}},
    "contact": {{"damage": 1, "destroySelf": true}}, "life": {{"ttl": 3}} }} }},
  "root": {{ "id": "spitter", "tags": ["enemy"],
    "visual": {{"shape": "capsule", "size": [1.0, 1.2], "tint": "#8bd450"}},
    "body": {{"shape": "box", "size": [0.9, 1.1], "gravity": 0}},
    "health": {{"max": 6}}, "contact": {{"damage": 1}},
    "motion": {{"type": "hover", "speed": 3, "range": 6}},
    "emitters": {{ "mouth": {{"at": [0.4, 0], "ref": "glob", "pattern": "fan"}} }} }},
  "brain": {{ "start": "fight", "states": {{ "fight": {{ "tracks": [
    {{ "id": "shoot", "loop": true, "steps": [
      {{"telegraph": {{"part": "spitter", "time": 0.4}}}},
      {{"fire": {{"emitter": "mouth", "count": 3, "spread": 30}}}},
      {{"wait": 1.2}} ] }} ] }} }} }}
}}

Return JSON only."""


def _mock_spec(description: str) -> dict:
    """Deterministic spec keyed off keywords — no API key required."""
    text = description.lower()
    boss = any(w in text for w in ("boss", "wing", "phase", "core", "giant", "moth"))
    flying = any(w in text for w in ("fly", "flying", "air", "moth", "bat", "float", "hover"))
    fast = any(w in text for w in ("fast", "quick", "swift", "dash", "charge"))

    shard = {
        "id": "shard",
        "tags": ["enemy", "projectile"],
        "visual": {"shape": "diamond", "size": [0.3, 0.3], "tint": "#f07178"},
        "body": {"shape": "circle", "radius": 0.15, "gravity": 0},
        "motion": {"type": "velocity", "speed": 6},
        "contact": {"damage": 1, "destroySelf": True},
        "life": {"ttl": 2.5},
    }

    if not boss:
        root = {
            "id": "grunt",
            "tags": ["enemy"],
            "visual": {"shape": "capsule" if not flying else "diamond",
                       "size": [1.0, 1.2], "tint": "#6fc3ff" if flying else "#7bd88f"},
            "body": {"shape": "box", "size": [0.9, 1.1], "gravity": 0 if flying else 1},
            "health": {"max": 4},
            "motion": {"type": "hover" if flying else ("dash" if fast else "chase"),
                       "target": "player", "speed": 5 if fast else 2.5, "range": 7},
            "contact": {"damage": 1, "knockback": 3},
            "emitters": {"muzzle": {"at": [0.5, 0], "ref": "shard", "pattern": "aimed"}},
            "on": {"destroy": [{"signal": {"name": "gruntDown"}}]},
        }
        return {
            "v": 1, "id": "mock_grunt", "name": "Mock Grunt", "kind": "enemy",
            "defs": {"shard": shard}, "root": root,
        }

    def wing(side, x):
        return {
            "id": f"{side}Wing",
            "tags": ["bossPart", "wing"],
            "at": [x, 0],
            "visual": {"shape": "diamond", "size": [1.8, 0.8], "tint": "#ffb454"},
            "health": {"max": 20},
            "emitters": {"missiles": {"at": [x * 0.3, 0], "ref": "seeker", "pattern": "fan"}},
            "on": {"destroy": [{"signal": {"name": "wingDestroyed"}}]},
        }

    seeker = {
        "id": "seeker",
        "tags": ["enemy", "projectile", "shootable"],
        "visual": {"shape": "circle", "size": [0.4, 0.4], "tint": "#f07178"},
        "body": {"shape": "circle", "radius": 0.2, "gravity": 0},
        "health": {"max": 2},
        "motion": {"type": "home", "target": "player", "speed": 2.4},
        "contact": {"damage": 1, "destroySelf": True},
        "life": {"ttl": 8},
        "on": {"destroy": [{"spawn": {"ref": "shard", "pattern": "ring"}},
                           {"signal": {"name": "missileDestroyed"}}]},
    }
    root = {
        "id": "core",
        "tags": ["boss"],
        "visual": {"shape": "ellipse", "size": [2.8, 1.4], "tint": "#c792ea"},
        "body": {"shape": "box", "size": [2.4, 1.1], "gravity": 0},
        "health": {"max": 100},
        "children": [wing("left", -1.7), wing("right", 1.7)],
    }
    brain = {
        "start": "phase1",
        "states": {
            "phase1": {
                "tracks": [
                    {"id": "air", "loop": True, "steps": [
                        {"moveTo": {"target": "arena.randomAir", "speed": 3}},
                        {"wait": {"range": [0.3, 0.7]}}]},
                    {"id": "missiles", "loop": True, "steps": [
                        {"telegraph": {"part": "leftWing", "time": 0.5, "style": "flash"}},
                        {"fire": {"emitter": "leftWing.missiles", "count": 2,
                                  "pattern": "fan", "spread": 20}},
                        {"fire": {"emitter": "rightWing.missiles", "count": 2,
                                  "pattern": "fan", "spread": 20}},
                        {"wait": 1.8}]},
                ],
                "transitions": [{"when": "self.hpPct <= 0.5", "to": "phase2"}],
            },
            "phase2": {
                "tracks": [{"id": "rage", "loop": True, "steps": [
                    {"dash": {"target": "player", "speed": 7}}, {"wait": 0.7}]}],
            },
        },
    }
    return {
        "v": 1, "id": "mock_moth", "name": "Mock Iron Moth", "kind": "boss",
        "limits": {"maxAlive": 80, "maxSpawnsPerSecond": 20, "maxSpawnDepth": 4},
        "vars": {"rage": 0},
        "defs": {"shard": shard, "seeker": seeker},
        "root": root, "brain": brain,
    }


def generate(description: str, *, reset_budget: bool = True) -> dict:
    """Generate and validate an EntitySpec from a natural-language description.

    Returns {"spec", "validation", "attempts", "mode", "tokens", "error"}.
    Retries with the validator's complaints fed back to the model.
    """
    description = (description or "").strip()
    if not description:
        return {"spec": None, "validation": None, "attempts": 0,
                "mode": "mock" if _use_mock() else "llm",
                "error": "description is empty"}

    if _use_mock():
        spec = _mock_spec(description)
        return {"spec": spec, "validation": schema.validate(spec).as_dict(),
                "attempts": 1, "mode": "mock", "tokens": llm.cycle_usage(),
                "error": None}

    if reset_budget:
        llm.reset_cycle_usage()
    user = f"Design this entity:\n{description}"
    last_errors: list[str] = []
    spec = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        prompt = user
        if last_errors:
            prompt = (user + "\n\nYour previous JSON failed validation:\n- "
                      + "\n- ".join(last_errors)
                      + "\nReturn a corrected EntitySpec. JSON only.")
        try:
            spec = llm.complete_json(SYSTEM, prompt, MODEL, max_tokens=8000,
                                     label=f"entity_design#{attempt}")
        except llm.BudgetExceeded as err:
            return {"spec": spec, "validation": None, "attempts": attempt,
                    "mode": "llm", "tokens": llm.cycle_usage(), "error": str(err)}
        result = schema.validate(spec)
        if result.ok:
            return {"spec": spec, "validation": result.as_dict(), "attempts": attempt,
                    "mode": "llm", "tokens": llm.cycle_usage(), "error": None}
        last_errors = result.errors

    return {"spec": spec, "validation": schema.validate(spec).as_dict(),
            "attempts": MAX_ATTEMPTS, "mode": "llm", "tokens": llm.cycle_usage(),
            "error": f"spec still invalid after {MAX_ATTEMPTS} attempts"}
