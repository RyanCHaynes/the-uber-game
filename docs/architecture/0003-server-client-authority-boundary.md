# ADR 0003: Server/client authority boundary

- **Status:** Accepted design contract; implementation remains gated on baseline freeze
- **Date:** 2026-07-18
- **TD task:** `td-ac4b.2.3`
- **Depends on:** [ADR 0001](0001-vnext-engine-and-designer-boundary.md)
- **Review base:** `fc39b53acdb2032ab4f542a0daf1e3b7f6def878`
- **Production baseline:** `52941476f9af110df9be0b3a0a118d4b76c38e0a`
- **Related contracts:** mode semantics (`td-ac4b.2.2`), deterministic replay (`td-ac4b.2.4`), content lifecycle (`td-ac4b.2.5`), atomic file protocol (`td-ac4b.2.6`)

## 1. Purpose

This contract fixes the trust boundary between the authoritative Coin Rush Engine and every browser client. It applies to immediate single-player PvE and retained two-to-ten-player modes. The mode contract decides when and with whom a session starts; this contract decides which side is allowed to determine each fact.

The governing rule is:

> A browser expresses bounded player intent and presents server-approved state. The Engine alone determines gameplay truth.

A modified, delayed, duplicated, compromised, or disconnected client must not be able to create a position, hit, kill, score, item, progression result, level transition, content activation, or other authoritative outcome.

## 2. Trust domains

### 2.1 Authoritative Engine domain

The trusted Engine consists of reviewed, versioned server code plus one validated, immutable active content revision. It runs without an LLM, image model, Designer service, or browser being trusted for simulation.

The Engine owns:

- connection admission, room/session identity, capacity, slots, mode, and lifecycle;
- the active engine version, protocol version, content revision, level, seed, and simulation tick;
- fixed-step time, deterministic ordering, and all simulation randomness;
- player and enemy spawn/despawn state;
- movement, velocity, gravity, grounding, collision, traversal constraints, and world bounds;
- enemy perception, behavior-state transitions, target selection, pathing primitives, and action choice;
- attack eligibility, wind-up, active/recovery timing, cooldowns, hitboxes, hurtboxes, hit tests, damage, resistance, knockback, invulnerability, health, death, and drops;
- pickups, inventory/progression flags, checkpoints, scoring, level completion, victory/defeat, reset, and next-level eligibility;
- disconnect, timeout, reconnect/resume eligibility, forfeiture, and cleanup outcomes under the mode contract;
- schema and semantic validation, dry runs, budgets, last-known-good selection, atomic between-level activation, rejection, and rollback;
- authoritative event and telemetry records.

Only reviewed Engine code may add a gameplay primitive. Content can parameterize an allowlisted primitive but cannot introduce code or expand authority.

### 2.2 Untrusted browser domain

Every browser is untrusted, including the browser serving the local player. It may:

- sample keyboard, pointer, controller, touch, and accessibility controls;
- translate those controls into a bounded protocol intent;
- retain cosmetic preferences such as volume, key bindings, reduced motion, UI scale, and local name history;
- interpolate or extrapolate only for presentation within a bounded visual policy;
- render server-approved state, same-origin validated assets, UI, camera, audio, particles, tweening, flashes, trails, and screen shake;
- draft and explicitly submit bounded player feedback.

The browser may never author or confirm gameplay truth. Local prediction, if later introduced, is disposable presentation state: every authoritative update replaces it, disagreement cannot damage another entity, and predicted state cannot feed back as a trusted fact.

### 2.3 External Designer domain

The Designer, annotator, image generator, and any human producer are outside the live client/server protocol and outside the trusted Engine.

- They communicate with the Engine only through the separately specified atomic file inbox/outbox.
- They cannot connect as an authority peer, send live gameplay commands, publish directly to browsers, or mutate an active level.
- Their output is bounded JSON and PNG data, never executable logic.
- Browsers cannot submit candidate content or choose which candidate activates.
- Candidate assets become browser-visible only after Engine validation, immutable assembly, activation between levels, and publication through an active content manifest.

Designer absence, latency, malformed output, or failure cannot stop a level from starting, playing, completing, or transitioning on last-known-good content.

## 3. Authority matrix

| Fact or action | Browser may propose/display | Engine decides | Notes |
|---|---:|---:|---|
| Display name | propose | yes | Server normalizes, bounds, de-duplicates, and assigns identity. |
| Protocol/client capabilities | declare | yes | Server accepts an exact supported version/capability set or rejects; no permissive downgrade. |
| Session, room, mode, slot, team | no | yes | Never accepted from client authority fields. |
| Ready/start/leave | intent | yes | Mode contract controls whether the intent changes lifecycle state. |
| Movement direction, jump, dodge, attack, interact | intent | yes | Intent carries no result, position, target truth, or timing authority. |
| Aim/facing, if enabled by a reviewed attack primitive | bounded intent | yes | Quantized/ranged by protocol; server derives attack geometry and legal targets. |
| Tick, elapsed time, cooldown | no | yes | Client time may be diagnostic only and is never simulation input. |
| Position, velocity, collision, grounded state | display | yes | Client interpolation cannot become server state. |
| Enemy state/AI/target/path | display | yes | No client-side AI decision is authoritative. |
| Hit, damage, health, death, drop | display | yes | A client cannot report a hit or damage amount. |
| Pickup, inventory, checkpoint, progression | request interaction | yes | Server verifies world state and eligibility. |
| Score, completion, winner, reset, transition | display | yes | Server emits final events/snapshots. |
| Active content/asset revision | request nothing | yes | Pinned by server for the complete level. |
| Camera, interpolation, VFX, audio, accessibility | yes | no gameplay effect | Collision and attack timing are independent of presentation. |
| Player feedback text/rating | submit bounded statement | receipt/retention | Feedback is a statement, not gameplay truth or automatic activation authority. |

## 4. Client-to-server protocol

### 4.1 Closed message union

Client traffic is a versioned, closed, discriminated union. Each message has one allowlisted `type`, exact required fields, explicitly allowed optional fields, and bounded values. Unknown types, unknown authority-bearing fields, malformed objects, arrays where objects are required, non-finite numbers, out-of-range values, and excessive nesting fail closed.

The vNext union may include only reviewed equivalents of:

- handshake/hello and protocol-version declaration;
- ready, start-mode selection where permitted by `td-ac4b.2.2`, leave, and explicit reconnect/resume proof;
- sampled control-state or discrete action intent with a monotonically increasing client sequence;
- bounded feedback submission at an eligible end-of-level boundary;
- heartbeat/latency acknowledgement if the transport requires it.

The exact wire schemas belong to implementation/schema tasks. They must not add generic commands, arbitrary key/value payloads, client-selected event names, arbitrary URLs, filesystem paths, serialized behavior, or “admin” escape hatches.

### 4.2 Intent shape rules

A gameplay intent describes controls, never an outcome. It may include:

- bounded booleans or an allowlisted bitset for held controls;
- one reviewed, bounded action edge such as attack/interact;
- a quantized direction or aim value only when an allowlisted primitive needs it;
- a monotonically increasing sequence number.

It must not include or influence:

- server tick, elapsed simulation time, delta time, or cooldown completion;
- entity position/velocity, target entity truth, hit result, damage, health, score, inventory, spawn, seed, RNG output, or level completion;
- participant/slot/team ownership, content revision, asset digest, mode authority, or another player's state.

The server stamps accepted intent with its receive order and simulation tick. Duplicate or stale sequences cannot reapply an edge. Excessively future or discontinuous sequences fail according to a fixed protocol rule; they never advance simulation by client demand. Silence or input timeout deterministically returns held controls to neutral so a lost client cannot leave a character moving or attacking indefinitely.

### 4.3 Admission and transport limits

The implementation must preserve or strengthen the accepted baseline controls:

- Node listens on loopback; Caddy terminates HTTPS/WSS and proxies same-origin `/ws`;
- exact allowed `Origin` and path checks precede WebSocket admission;
- text frames only; binary frames are rejected;
- per-message compression remains disabled unless a reviewed resource analysis permits it;
- a finite payload ceiling is enforced before JSON processing (baseline: 4096 bytes);
- hello is required within a finite timeout (baseline: 5000 ms) before gameplay messages;
- room and global connection budgets are finite; an over-capacity peer is refused without disturbing accepted peers;
- each peer has a monotonic token-bucket or stricter rate budget (baseline: burst 90, refill 60 messages/second against approximately 30 Hz input);
- string lengths, object depth, array counts, numeric ranges, and feedback bytes are bounded before state transition;
- malformed JSON, unsupported protocol versions, wrong origins, pre-hello messages, unknown types, authority fields, and excessive rates are rejected with a bounded notice/close reason and deterministic cleanup.

IP-level abuse controls may exist at the edge, but they do not replace per-peer validation. Error text must not disclose stack traces, filesystem paths, secrets, unpublished content, Designer prompts, or internal policy.

## 5. Server processing order

For each simulation tick, the Engine follows a deterministic order defined fully by `td-ac4b.2.4`. This authority contract requires at least:

1. admit only already validated protocol messages;
2. map each accepted message to its server-owned participant/session identity;
3. order accepted intent by server tick and the deterministic tie-break contract, never by client wall-clock time;
4. derive legal control/action state from current authoritative state;
5. run movement, collision, AI, combat, damage, death, pickup, progression, and lifecycle systems in reviewed order;
6. append authoritative events and telemetry;
7. emit bounded state/event views to clients.

A packet cannot cause the Engine to skip steps, run extra ticks, rewind state, select a new content revision, or execute a primitive outside the active revision.

## 6. Server-to-client protocol

Server messages are bounded, versioned views of authority. They may include:

- server-assigned participant/session identity and slot;
- lobby/mode/lifecycle state;
- the active immutable content manifest/revision and same-origin content-addressed asset references;
- game-start and level-transition events;
- authoritative snapshots and ordered combat/progression events;
- bounded notices, feedback receipts, and terminal error reasons.

Every state-bearing message carries enough engine/protocol/content/session identity to reject cross-session, cross-level, stale, or mismatched data. Snapshots are complete or have an explicitly versioned delta/base contract; an implicit partial patch is forbidden.

The browser validates messages defensively before rendering. A browser-side validation failure may stop that client's rendering and reconnect flow, but it cannot rewrite server state. Server output never includes candidate inbox paths, arbitrary external URLs, raw Designer output, secrets, stack traces, or other players' private feedback.

## 7. Snapshot, interpolation, and presentation

- Authoritative snapshots/events are generated from completed simulation state at a server-owned cadence (baseline snapshot rate: 20 Hz).
- Rendering may interpolate between accepted snapshots or apply bounded cosmetic smoothing.
- The renderer must not write interpolated position, animation phase, camera state, particle collision, pose bounds, or asset dimensions back into simulation.
- Five-pose art (`idle`, `move`, `attack`, `hit`, `death`) is semantic presentation. Authoritative attack/hit/death timing comes from Engine data, not image frames or browser animation completion callbacks.
- If the client predicts its own movement, authoritative reconciliation is mandatory and prediction may never predict remote damage, drops, scoring, completion, or content activation as truth.
- Reduced-motion or low-performance presentation must produce identical authoritative outcomes.

## 8. Content and asset publication boundary

The Engine pins one immutable content revision for the complete level/session segment defined by the lifecycle contract.

- A server-approved manifest binds schema version, engine compatibility, content revision, file digests, dimensions/types, and budget results.
- Browsers load only assets named by that active manifest from same-origin, content-addressed paths.
- Redirects across origin, arbitrary URLs, data supplied from the candidate inbox, path traversal, missing digest matches, and late asset substitution fail closed.
- Asset decode or render failure affects presentation only; it cannot alter collision geometry or select a different gameplay revision.
- A candidate received during play remains invisible to live authority until validated, dry-run, atomically activated between levels, and selected by the Engine.
- Activation failure leaves every session on the last-known-good complete revision. No client vote or cache entry can override rollback.

## 9. Disconnect, reconnect, and failure invariants

Exact lifecycle consequences are set by `td-ac4b.2.2`. In every mode:

- disconnect atomically clears the peer's accepted held input and prevents further intent from that transport;
- cleanup, pause, forfeit, session termination, or resume eligibility is a server decision;
- a reconnect cannot claim an identity, slot, inventory, progression state, or live entity by name or client-local storage alone;
- any resume credential is opaque, bounded, server-issued, single-session scoped, expiring, and replay-protected;
- a client crash cannot change active content, preserve a stuck attack, corrupt another participant, or block last-known-good continuity;
- a slow consumer harms only that peer. Snapshots may be coalesced or dropped as presentation updates, but authoritative event order is never silently rewritten;
- outbound buffered bytes and queued messages are bounded. A peer exceeding the slow-consumer budget is closed and cleaned up rather than receiving an unbounded queue;
- server restart/recovery trusts only reviewed durable state and last-known-good content, never a browser's claimed snapshot;
- malformed, stale, duplicate, over-rate, or rejected input produces no partial gameplay mutation;
- Designer/annotator failure has no client-protocol side effect and cannot interrupt an active level.

## 10. Compatibility requirements

### 10.1 One-player PvE

A solo session uses the same authoritative Engine, validator, fixed-step simulation, enemy/combat rules, content pinning, snapshots/events, and security boundary as multiplayer. “Local player” does not imply local authority. No second browser or bot is required to establish truth.

### 10.2 Two-to-ten-player modes

Every participant is independently untrusted. The server owns capacity, deterministic slots/spawns, shared world state, per-peer intents, lifecycle, combat, score/progression, disconnect outcomes, and snapshots. An eleventh peer cannot evict or degrade accepted participants.

### 10.3 Accepted browser baseline

Until a reviewed vNext protocol replaces it, the accepted `5294147` baseline remains authoritative for production: `hello`, `ready`, and bounded four-direction `input`; server-assigned identity/slot; server-owned level, movement, collision, coin, score, winner, reset, and disconnect state; 50 Hz physics, 20 Hz snapshots, 4096-byte WebSocket payload limit, five-second handshake, exact origin, text-only frames, per-peer rate limiting, and ten-peer capacity.

This contract does not authorize changing or deploying that frozen release.

## 11. Prohibited designs

The following violate this boundary:

- client-reported position, velocity, damage, hits, health, kills, drops, score, winner, progression, or completion;
- client-selected entity IDs used as target truth without server eligibility checks;
- client wall-clock timestamps driving cooldowns, simulation delta, or input ordering;
- browser-side enemy AI whose decisions are accepted by the Engine;
- animation events or sprite dimensions controlling authoritative collisions or hit timing;
- permissive generic JSON commands, remotely named handlers, scripts, plugins, dynamic imports, or executable content;
- direct Designer-to-browser publication or Designer-to-live-room commands;
- mid-level content/asset mutation, remote asset URLs, or cache state choosing authority;
- unbounded payloads, rates, object graphs, feedback, logs, outbound queues, or retry loops;
- trusting names, local storage, cookies without server proof, or client-provided slots for reconnection;
- hiding protocol incompatibility behind silent fallback;
- allowing one malformed/slow peer to reset, starve, or corrupt unrelated sessions.

## 12. Required acceptance evidence

Implementation cannot claim this contract from documentation alone. Acceptance requires automated and independent evidence for:

### Protocol validator

- positive fixture for every client message at minimum/maximum allowed values;
- negative fixtures for missing/unknown fields, arrays, excessive nesting/length/counts, non-finite/out-of-range numbers, authority fields, and unsupported protocol/content/session identity;
- stale, duplicate, future, reordered, and replayed intent sequences;
- explicit proof that each rejected message causes zero gameplay mutation.

### Transport and abuse

- wrong path/origin, binary, malformed JSON, oversized, pre-hello, handshake timeout, over-rate, and capacity refusal;
- fragmented and rapid small-message cases under the same byte/rate budgets;
- bounded close reasons and no internal-data disclosure;
- slow-consumer test proving bounded memory/queue, deterministic peer cleanup, and unaffected healthy peers;
- connection churn and disconnect during lobby, active combat, game-over, and transition.

### Authority

- adversarial client attempts to submit position, tick, target, hit, damage, health, spawn, score, inventory, winner, revision, slot, mode, and progression fields; all fail closed;
- one-player PvE E2E proving no client-side authority or second peer is needed;
- two-, ten-, and over-capacity E2E proving shared server truth, distinct identity/slots, and isolated peer failure;
- authoritative movement/collision, enemy AI, attack timing, hit/damage/death, pickup/progression, completion, reset, and disconnect outcomes;
- modified client or DevTools state cannot alter another client's authoritative observation.

### Determinism and content

- replay of one seed/content/engine/input ledger produces identical authoritative state and event digests under `td-ac4b.2.4`;
- every client in a session observes the same pinned content revision and ordered authoritative event digest;
- candidate arrival during play cannot change live state or published assets;
- malformed, late, rejected, or failed activation preserves last-known-good and current play;
- Designer absent/slow/failing scenarios complete levels normally.

### Presentation isolation

- alternate frame rates, viewport sizes, reduced motion, animation speed, missing cosmetic asset, and disabled VFX yield identical authoritative results;
- five-pose tween/VFX changes do not change hitboxes, hurtboxes, attack windows, damage, or progression.

Existing baseline evidence from `td-ac4b.1.2` and `.1.3` may support backward compatibility but does not substitute for vNext combat, solo, replay, content, slow-consumer, or failure-mode evidence. Full solo acceptance remains mapped to `td-ac4b.4.2` and `td-ac4b.8.3`.

## 13. Non-goals

This contract does not define:

- exact solo/co-op/competitive mode selection and scoring semantics (`td-ac4b.2.2`);
- fixed-step ordering, RNG algorithm, replay file, or digest format (`td-ac4b.2.4`);
- candidate states, activation transaction, retention, or rollback layout (`td-ac4b.2.5`);
- filesystem directory names, atomic rename protocol, or receipt schemas (`td-ac4b.2.6`);
- the actual Designer agent, model, prompts, scheduler, or hosted service;
- exact enemy/attack/level schema fields or a new gameplay primitive;
- production deployment or mutation of the frozen accepted release.

## 14. Contract summary

The Engine is the only writer of gameplay truth. Browsers send small, versioned, rate-limited intents and render bounded, revision-bound authoritative state. Content producers never cross the live protocol boundary. Every queue, payload, rate, sequence, identifier, asset, and failure path is bounded; rejected input has zero gameplay effect; cosmetic presentation is simulation-independent; single-player and two-to-ten-player modes share the same authority model; and last-known-good content remains playable when clients, networks, or external creative systems fail.
