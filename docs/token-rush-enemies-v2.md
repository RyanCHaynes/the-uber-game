# Token Rush enemies v2

`content/token-rush-enemies.json` is the authored source for deterministic solo-enemy definitions. The authoritative validator is `shared/token-rush-enemies.js`; the authoritative interpreter is `server/token-rush-enemy-runtime.js`.

The level format remains `token-rush-level/v1`. A level instance still contains only a catalog ID and a supported grid position:

```json
{ "type": "ossuary-colossus", "x": 30, "y": 16 }
```

The server validates the catalog first, pins its normalized SHA-256 revision, and then validates level placements against the selected definitions. A bad catalog falls back to the immutable crawler/guard/warden catalog. A level that does not validate against the selected catalog falls back to the immutable known-good level and catalog.

## Definition

A `token-rush-enemies/v2` document has an authored revision and one to sixteen definitions. Each definition has:

- a stable `id`, bounded display `name`, and slug-only `assetPack` reference;
- one recursive `body` tree;
- declarative `controllers` containing finite state machines;
- declarative melee `attacks` containing finite timelines.

Unknown keys fail validation. URLs, script-like labels, paths, code, eval, and projectile fields are invalid.

## Nested parts

Every part explicitly defines:

- stable ID and display name;
- independent HP;
- parent-relative anchor;
- bounded rectangular body/hurtbox;
- placeholder render color;
- bounded detachment velocity;
- `onDestroyed.children` policy: `destroy` or `detach`;
- zero or more recursively nested children.

The runtime computes each part's authoritative world position from its entity root and live parent chain. Player melee selects and damages one overlapping part. A part at zero HP is removed from snapshots immediately, so it disappears rather than becoming an invisible attacker or corpse.

When a parent with `children: "detach"` is destroyed, each live direct child subtree is atomically removed and promoted to a new authoritative entity. A `part.detach` state-machine action can perform the same promotion while the part is alive. Promotion preserves current HP, descendants, attacks, and state definition; resets the promoted root anchor to zero; gives it a deterministic ID and bounded velocity; and never clones the subtree.

## Movement controllers

A controller owns one part and is active in one of two modes:

- `root`: active only when its owner is the entity root. This is how detached parts gain independent locomotion.
- `attached`: active only while its owner remains below another live root. This is how an attached head or arm can move relative to its parent.

Each controller declares an initial state. Every state declares bounded `enter` actions, per-tick actions, and ordered conditional transitions. There is no hardcoded `chaser` behavior.

Allowed actions are:

- `motor.setVelocityX`
- `motor.setVelocityY`
- `motor.face`
- `owner.setAnchorX`
- `owner.setAnchorY`
- `part.detach`

Numbers are literals or bounded expression trees using allowlisted sensor reads, arithmetic, `abs`, `sign`, and `clamp`. Conditions use comparisons, `all`, `any`, `not`, and allowlisted boolean reads. Relevant reads include target deltas/distances, root velocity/HP, owner HP/attachment, named part HP/aliveness, grounding, facing, and ticks spent in the current state.

The engine—not JSON—owns fixed-tick scheduling, collision resolution, gravity, maximum velocity, expression budgets, and world bounds.

## Melee attacks

An attack owns a part and is active while that part is `root`, `attached`, or `always`. It declares:

- a JSON condition that triggers the attack;
- a bounded cooldown;
- one to eight ordered phases;
- phase duration, entry actions, and zero to four attached hit volumes;
- bounded damage and knockback per hit volume.

This defines telegraph, active, and recovery timing without scripts. Hit volumes follow the owner part's live world position and entity facing, and each volume can damage the player once per attack cycle.

Projectiles are deliberately not part of v2. Unknown projectile keys or actions fail closed and require a future schema version.

## Budgets

The validator enforces a 64 KiB file limit plus fixed ceilings: 16 enemy definitions, 24 parts per enemy, depth 4, 6 children per part, 24 controllers, 32 states per controller, 8 actions per step, 8 transitions per state, 24 attacks, 8 phases per attack, 4 hit volumes per phase, expression depth 8, and 32 expression nodes.

All authored numbers and references are bounded and validated before a session starts. Active sessions retain their compiled catalog revision and never hot-swap.

## Included demonstration: Ossuary Colossus

`ossuary-colossus` has seven parts across three levels: core; skull with crown; two reliquary arms with claws. `content/token-rush-enemy-demo-level.json` places it without changing the frozen learned level used by the accepted evaluator proof. It can be selected locally with `TOKEN_RUSH_LEVEL_FILE=content/token-rush-enemy-demo-level.json npm start`; the server still binds to localhost by default. Its JSON:

- moves the core through approach, split, and enraged states;
- bobs the skull and swings both attached arms;
- detaches the left arm when the player enters range;
- activates an independent pursuit controller on the detached arm;
- gives the core, skull, attached claws, and detached claws different melee timelines;
- detaches a crown or claw when its configured parent is destroyed;
- preserves independent HP and immediate disappearance for every destroyed part.
