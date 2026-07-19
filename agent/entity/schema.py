"""EntitySpec vocabulary and validator.

The closed vocabulary is drawn from ``llm_adaptive_boss_system_plan.md`` and
scoped to the plan's "Implement First" set (sections 14 and 6). The LLM has a
fixed set of verbs but free composition; this module is the gate that keeps its
output inside that vocabulary before anything downstream trusts it.

Validation is deliberately structural — it treats the spec like source that
must compile. It does not run behavior. Errors block; warnings inform.
"""

# --- Closed vocabulary (the model may only use these) -----------------------

SHAPES = {"circle", "box", "ellipse", "diamond", "triangle", "capsule"}

# Initial motion controllers (plan section 14).
MOTIONS = {
    "static", "velocity", "gravity", "moveTo", "patrol",
    "chase", "home", "orbit", "hover", "dash",
}

# Initial attack/emitter patterns (plan section 14).
PATTERNS = {"single", "burst", "fan", "ring", "aimed"}

# Standard events an entity may react to (plan section 7), scoped.
EVENTS = {
    "spawn", "destroy", "damage", "healthBelow", "contact",
    "childDestroyed", "partDestroyed", "playerNear", "playerFar",
    "timer", "signal", "stateEnter", "stateExit",
}

# Initial discrete actions (plan section 14).
ACTIONS = {
    "wait", "moveTo", "setMotion", "fire", "spawn", "telegraph",
    "set", "add", "mul", "signal", "destroy", "detach", "enable", "disable",
}

KINDS = {"enemy", "boss"}

# Safety ceilings the engine will also enforce; used here to reject absurd specs.
MAX_CHILDREN_DEPTH = 4
MAX_TOTAL_ENTITIES = 64
MAX_HEALTH = 100000


class ValidationResult:
    def __init__(self):
        self.errors: list[str] = []
        self.warnings: list[str] = []

    @property
    def ok(self) -> bool:
        return not self.errors

    def err(self, msg: str):
        self.errors.append(msg)

    def warn(self, msg: str):
        self.warnings.append(msg)

    def as_dict(self) -> dict:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings}


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _enum_check(value, allowed: set, field: str, r: ValidationResult):
    """Report an error if ``value`` (when present) is not a string in ``allowed``.

    Guards the membership test so a dict/list the model wrongly supplied becomes
    a validation finding instead of an ``unhashable type`` crash.
    """
    if value is None:
        return
    if not isinstance(value, str):
        r.err(f"{field} must be a string, got {type(value).__name__}")
    elif value not in allowed:
        r.err(f"{field} {value!r} is not in {sorted(allowed)}")


def _check_visual(node: dict, path: str, r: ValidationResult):
    visual = node.get("visual")
    if visual is None:
        r.warn(f"{path}: no visual; engine will use a default box")
        return
    if not isinstance(visual, dict):
        r.err(f"{path}.visual must be an object")
        return
    _enum_check(visual.get("shape"), SHAPES, f"{path}.visual.shape", r)


def _check_body(node: dict, path: str, r: ValidationResult):
    body = node.get("body")
    if body is None:
        return
    if not isinstance(body, dict):
        r.err(f"{path}.body must be an object")
        return
    _enum_check(body.get("shape"), SHAPES, f"{path}.body.shape", r)


def _check_health(node: dict, path: str, r: ValidationResult):
    health = node.get("health")
    if health is None:
        return
    if not isinstance(health, dict):
        r.err(f"{path}.health must be an object")
        return
    hp = health.get("max")
    if hp is not None:
        if not _is_num(hp) or hp <= 0:
            r.err(f"{path}.health.max must be a positive number, got {hp!r}")
        elif hp > MAX_HEALTH:
            r.err(f"{path}.health.max {hp} exceeds ceiling {MAX_HEALTH}")


def _check_motion(node: dict, path: str, r: ValidationResult):
    motion = node.get("motion")
    if motion is None:
        return
    if not isinstance(motion, dict):
        r.err(f"{path}.motion must be an object")
        return
    if motion.get("type") is None:
        r.err(f"{path}.motion has no type")
    else:
        _enum_check(motion.get("type"), MOTIONS, f"{path}.motion.type", r)
    # Numeric motion args must be non-negative numbers when present. `range` is the
    # player awareness radius for seeking motions (chase/home/hover/orbit).
    for arg in ("range", "speed", "radius", "turnRate", "rate"):
        value = motion.get(arg)
        if value is not None and (not _is_num(value) or value < 0):
            r.err(f"{path}.motion.{arg} must be a non-negative number, got {value!r}")


def _check_life(node: dict, path: str, r: ValidationResult):
    life = node.get("life")
    if life is None:
        return
    ttl = life.get("ttl") if isinstance(life, dict) else None
    if ttl is not None and (not _is_num(ttl) or ttl <= 0):
        r.err(f"{path}.life.ttl must be a positive number, got {ttl!r}")


def _collect_emitter_refs(node: dict, path: str, refs: list, r: ValidationResult):
    emitters = node.get("emitters")
    if not isinstance(emitters, dict):
        return
    for name, em in emitters.items():
        if not isinstance(em, dict):
            r.err(f"{path}.emitters.{name} must be an object")
            continue
        ref = em.get("ref")
        if ref is not None:
            if isinstance(ref, str):
                refs.append((f"{path}.emitters.{name}.ref", ref))
            else:
                r.err(f"{path}.emitters.{name}.ref must be a string id, "
                      f"got {type(ref).__name__}")
        _enum_check(em.get("pattern"), PATTERNS, f"{path}.emitters.{name}.pattern", r)


def _check_events(node: dict, path: str, r: ValidationResult, spawn_refs: list):
    on = node.get("on")
    if on is None:
        return
    if not isinstance(on, dict):
        r.err(f"{path}.on must be an object keyed by event name")
        return
    for event, actions in on.items():
        _enum_check(event, EVENTS, f"{path}.on key", r)
        if not isinstance(actions, list):
            r.err(f"{path}.on.{event} must be a list of actions")
            continue
        for i, action in enumerate(actions):
            if not isinstance(action, dict) or len(action) != 1:
                r.err(f"{path}.on.{event}[{i}] must be a single-verb object")
                continue
            verb = next(iter(action))
            _enum_check(verb, ACTIONS, f"{path}.on.{event}[{i}] action", r)
            if verb == "wait":
                r.warn(f"{path}.on.{event}[{i}]: 'wait' in an event handler does nothing; "
                       "put timed sequences in a brain track's steps, not in 'on'")
            if verb == "spawn":
                ref = action["spawn"].get("ref") if isinstance(action["spawn"], dict) else None
                if ref is not None and isinstance(ref, str):
                    spawn_refs.append((f"{path}.on.{event}[{i}].spawn.ref", ref))
                elif ref is not None:
                    r.err(f"{path}.on.{event}[{i}].spawn.ref must be a string id, "
                          f"got {type(ref).__name__}")


def _walk_entity(node: dict, path: str, depth: int, r: ValidationResult,
                 ids: dict, emitter_refs: list, spawn_refs: list, count: list):
    if not isinstance(node, dict):
        r.err(f"{path} must be an object")
        return
    count[0] += 1
    eid = node.get("id")
    if eid is None:
        r.err(f"{path} has no id")
    elif not isinstance(eid, str):
        r.err(f"{path}.id must be a string, got {type(eid).__name__}")
    else:
        if eid in ids:
            r.err(f"duplicate id {eid!r} at {path} (also at {ids[eid]})")
        ids[eid] = path

    _check_visual(node, path, r)
    _check_body(node, path, r)
    _check_health(node, path, r)
    _check_motion(node, path, r)
    _check_life(node, path, r)
    _collect_emitter_refs(node, path, emitter_refs, r)
    _check_events(node, path, r, spawn_refs)

    children = node.get("children")
    if children is not None:
        if not isinstance(children, list):
            r.err(f"{path}.children must be a list")
        elif depth + 1 > MAX_CHILDREN_DEPTH:
            r.err(f"{path}.children exceeds max nesting depth {MAX_CHILDREN_DEPTH}")
        else:
            for i, child in enumerate(children):
                _walk_entity(child, f"{path}.children[{i}]", depth + 1, r,
                             ids, emitter_refs, spawn_refs, count)


def validate(spec) -> ValidationResult:
    """Structurally validate an EntitySpec. Never raises; collects findings."""
    r = ValidationResult()
    if not isinstance(spec, dict):
        r.err("spec must be a JSON object")
        return r

    for field in ("id", "name", "root"):
        if field not in spec:
            r.err(f"missing required top-level field {field!r}")

    kind = spec.get("kind", "enemy")
    if kind not in KINDS:
        r.err(f"kind {kind!r} must be one of {sorted(KINDS)}")

    ids: dict = {}
    emitter_refs: list = []
    spawn_refs: list = []
    count = [0]

    # defs are reusable templates (projectiles, summons); they share the id space.
    defs = spec.get("defs")
    def_ids = set()
    if defs is not None:
        if not isinstance(defs, dict):
            r.err("defs must be an object keyed by template id")
        else:
            for def_id, template in defs.items():
                def_ids.add(def_id)
                template = dict(template) if isinstance(template, dict) else template
                if isinstance(template, dict):
                    template.setdefault("id", def_id)
                _walk_entity(template, f"defs.{def_id}", 0, r,
                             ids, emitter_refs, spawn_refs, count)

    root = spec.get("root")
    if root is not None:
        _walk_entity(root, "root", 0, r, ids, emitter_refs, spawn_refs, count)
        if isinstance(root, dict) and root.get("body") is None:
            r.warn("root: no body; the entity will have no collision")

    if count[0] > MAX_TOTAL_ENTITIES:
        r.err(f"{count[0]} entities exceeds ceiling {MAX_TOTAL_ENTITIES}")

    # Reference validation: every emitter/spawn ref must resolve to a def or id.
    resolvable = set(ids) | def_ids
    for where, ref in emitter_refs:
        if ref not in resolvable:
            r.err(f"{where}: {ref!r} does not match any def or entity id")
    for where, ref in spawn_refs:
        if ref not in resolvable:
            r.err(f"{where}: spawn ref {ref!r} does not match any def or entity id")

    # Boss safety limits (plan section 10.4).
    if kind == "boss":
        limits = spec.get("limits")
        if not isinstance(limits, dict):
            r.warn("boss has no limits block; engine defaults will apply")
        else:
            for key in ("maxAlive", "maxSpawnsPerSecond", "maxSpawnDepth"):
                v = limits.get(key)
                if v is not None and (not _is_num(v) or v <= 0):
                    r.err(f"limits.{key} must be a positive number, got {v!r}")

    # Brain transitions must point at real states (plan section 10.2).
    brain = spec.get("brain")
    if isinstance(brain, dict):
        states = brain.get("states")
        if isinstance(states, dict):
            start = brain.get("start")
            if start is not None and not (isinstance(start, str) and start in states):
                r.err(f"brain.start {start!r} is not a defined state")
            for sid, state in states.items():
                if not isinstance(state, dict):
                    continue
                for t in state.get("transitions") or []:
                    to = t.get("to") if isinstance(t, dict) else None
                    if to is not None and not (isinstance(to, str) and to in states):
                        r.err(f"brain.states.{sid}: transition to {to!r} is not a state")
                # Behavior check (plan 10.3): a state whose tracks are all empty and
                # which has no enter actions will never do anything.
                tracks = state.get("tracks") or []
                has_steps = any(isinstance(t, dict) and (t.get("steps") or [])
                                for t in tracks)
                if tracks and not has_steps and not (state.get("enter") or []):
                    r.warn(f"brain.states.{sid}: every track has empty steps and there "
                           "are no enter actions — this state does nothing. Put the "
                           "attack/movement sequence in a track's steps.")

    return r
