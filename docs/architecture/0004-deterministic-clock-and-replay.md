# ADR 0004: Deterministic clock and authoritative replay

- **Status:** Accepted design contract; implementation remains gated on baseline freeze
- **Date:** 2026-07-18
- **TD task:** `td-ac4b.2.4`
- **Depends on:** [ADR 0001](0001-vnext-engine-and-designer-boundary.md), ADR 0002 session semantics (`td-ac4b.2.2`, reviewed head `28464a418911b1d23e0c3aff17af0d55882709e9`), [ADR 0003](0003-server-client-authority-boundary.md)
- **Review base:** `16c9816c4768152a91c7e6691a897be6ffae519b`
- **Production baseline:** `52941476f9af110df9be0b3a0a118d4b76c38e0a`
- **Related contracts:** content lifecycle (`td-ac4b.2.5`), atomic file protocol (`td-ac4b.2.6`), checkpoints/rejoin (`td-ac4b.4.13`)

## 1. Purpose

Coin Rush vNext must produce the same authoritative result when the same reviewed Engine release replays the same immutable content, seed, initial facts, and ordered accepted inputs. Transport conditions may affect the explicit tick at which an intent is admitted, but network timing, browser frame rate, host load, wall-clock jumps, rendering, and Designer availability cannot become hidden simulation inputs or reorder a closed authoritative batch.

This contract fixes:

- the fixed-step simulation clock and overload behavior;
- authoritative input admission and same-tick ordering;
- system execution and side-effect order;
- deterministic arithmetic, identity allocation, and randomness;
- the canonical replay segment, hash chain, state/event digests, and verification procedure;
- pause, disconnect, crash, checkpoint, content, and multi-session lineage rules.

The governing rule is:

> Wall time schedules work; integer ticks determine gameplay; the sealed authoritative ledger determines replay.

“Must” and “must not” are acceptance requirements.

## 2. Normative vocabulary

- **Engine release:** One immutable reviewed source tree, dependency lock, runtime/container identity, protocol version, deterministic-arithmetic profile, and replay-schema version.
- **Simulation tick:** One complete fixed-step state transition. Tick numbers are unsigned integers and never wall-clock timestamps.
- **Completed tick:** The greatest tick whose ordered inputs, authoritative events, state digest, RNG digest, and ledger commit are sealed.
- **Ingress sequence:** A monotonic server-assigned integer given to a fully validated client or system input. It is not chosen by a client.
- **Apply tick:** The first simulation tick at whose input cutoff an accepted input is eligible to affect state.
- **Control record:** A server-owned exogenous fact such as disconnect, grace expiry, pause/resume, checkpoint restore, or boundary decision. It is ordered in the same authoritative ledger as player intent.
- **Replay segment:** One immutable active-level ledger from pinned initial state through one sealed level result, failure, abort, or checkpoint transition.
- **Replay lineage:** The ordered chain of replay-segment digests and boundary/checkpoint receipts for one session.
- **Canonical state:** The complete simulation-relevant state in the required stable order, excluding presentation, transport, diagnostics, and wall time.
- **Authoritative event:** A bounded Engine result such as spawn, attack, hit, damage, death, pickup, objective progress, completion, failure, or lifecycle transition.

## 3. Engine-release identity

A replay is valid only against its exact Engine release. The release identity binds at least:

- full Git commit and tree IDs;
- dependency-lock digest;
- Node/runtime and immutable container-image identity;
- protocol, content-schema, replay-schema, tick-pipeline, arithmetic, RNG, and digest algorithm IDs;
- any reviewed feature flags that can change simulation.

A dirty worktree, mutable dependency range, unrecorded environment switch, or different simulation-affecting flag is a different release. A verifier must fail closed on an unknown or mismatched release; it must not attempt a “close enough” replay.

Cross-release migration or comparison may be a separate diagnostic tool, but it cannot certify the original authoritative result.

## 4. Fixed-step clock

### 4.1 Tick rate

The vNext deterministic profile uses:

```text
TICK_RATE_HZ = 50
TICK_DURATION = 20 milliseconds of nominal scheduler time
first active transition = tick 0
```

Every authoritative movement, AI, combat, cooldown, invulnerability, objective, and simulation timer is expressed in integer ticks. The retained `coin-race-v1` compatibility mode preserves the accepted 50 Hz baseline.

No simulation system may consume variable `deltaTime`, browser time, packet timestamps, `Date.now()`, local time zone, frame count, render interpolation, or unquantized elapsed seconds.

### 4.2 Scheduler and accumulator

A monotonic host clock may wake the Engine and measure backlog, but it has no direct gameplay authority.

- The scheduler accumulates nominal 20 ms quanta and executes complete ticks.
- It never scales a tick, merges ticks, or drops a simulation transition to catch up.
- A bounded number of contiguous catch-up ticks may run without publishing an intermediate network snapshot; each tick still executes and seals separately.
- The exact catch-up ceiling and overload threshold are release constants and do not alter tick results.
- If backlog exceeds the release threshold, the Engine stops admission and scheduler execution at the last completed tick. It emits bounded operational health evidence, but host backlog alone creates no gameplay event, RNG draw, state mutation, or authoritative replay record.
- Operational recovery resumes from the same completed state with no accumulated catch-up. A separately authorized abort or lifecycle decision is an explicit control record; overload is never its hidden substitute.

Changing scheduler cadence, host load, operational stall/resume, or snapshot publication cadence with the same ordered ledger must leave every authoritative digest unchanged.

### 4.3 Pauses and no-player intervals

When session semantics require a pause, the current tick finishes and seals before the pause becomes effective. While paused:

- the simulation tick does not advance;
- gameplay intent is rejected or reduced to neutral according to the protocol; it is not queued for a future burst;
- no cooldown, AI, damage, objective, or gameplay timer advances;
- wall-clock grace or operational expiry may produce one ordered control record at the current completed tick;
- resume starts with neutral held input unless a later accepted input says otherwise.

A wall-clock deadline is therefore an input to lifecycle scheduling, not a hidden simulation clock. Replay applies the recorded expiry/resume fact at its authoritative ledger position without waiting in real time.

## 5. Deterministic arithmetic

Authoritative vNext simulation uses bounded integers, not unconstrained floating-point state.

- Spatial values use signed integer simulation units with `SIM_SCALE = 1000` subunits per content world unit, preserving the accepted baseline’s decimal `0.01`, `0.02`, and `4.7` movement/collision quantities exactly.
- Tick counts, health, damage, inventory, score, ordinal IDs, and objective counters are integers.
- Schema-defined fractions are converted once at content validation using an exact documented rational conversion.
- General integer division truncates toward zero. Spatial tile/cell lookup uses a separate exact floor-division helper toward negative infinity. Every multiply/divide helper defines operation order before rounding.
- Authoritative values and intermediate products must remain within the release’s checked safe-integer bounds. Overflow, non-finite input, or out-of-range conversion fails validation or the tick before partial mutation; it never silently wraps or saturates.
- Angles, directions, slopes, easing choices, and thresholds used by simulation are quantized integers or finite lookup tables committed in the Engine release.
- `Math.random()` and platform-dependent transcendental functions are forbidden in authoritative systems.

Rendering may convert authoritative integers to floating-point coordinates and run cosmetic tweening. Those values never return to simulation.

## 6. Stable identity and container order

Determinism must not depend on JavaScript object insertion order, hash-map layout, filesystem enumeration, network callback order, or host process scheduling.

- Sessions, members, slots, levels, entities, attacks, pickups, objectives, and RNG streams use explicit stable IDs.
- Runtime entity IDs are allocated from a monotonic per-segment counter at one defined pipeline phase.
- Creation requests are sorted by `(requestPhase, ownerSlot, sourceEntityId, localOrdinal)` before IDs are assigned.
- Removal is deferred, sorted by entity ID, and committed at the defined cleanup phase.
- Any simulation iteration over entities, contacts, targets, hits, drops, or objectives uses an explicit stable sort key.
- Ties that can affect gameplay are resolved by contract keys, never by “first returned” collection behavior.

Display names, socket IDs, IP addresses, browser-local IDs, and random UUID generation are not ordering keys.

## 7. Input admission and tick cutoff

### 7.1 Validation before authority

The closed client message union and bounds from ADR 0003 are applied before an input can enter the replay ledger. A rejected, stale, duplicate, malformed, unauthorized, or over-rate message:

- receives no ingress sequence in the authoritative ledger;
- consumes no RNG value;
- changes no held control, event digest, state digest, or simulation state;
- may appear only in a separate bounded diagnostic/abuse log.

### 7.2 Double-buffered cutoff

For each active tick `T`, the Engine atomically closes an admission buffer before simulation begins.

- A fully validated input admitted before that cutoff receives `applyTick = T`.
- A frame whose complete validation finishes after the cutoff receives `applyTick = T + 1` or later under an explicit pause rule.
- The cutoff’s highest ingress sequence is recorded in the tick commit.
- Network receive timestamps are diagnostic only and are not replay fields or ordering authority.

An accepted admission record is durably appended before the corresponding input may mutate a tick. If the authoritative ledger cannot accept the record, the Engine pauses before mutation.

### 7.3 Canonical same-tick order

Inputs for one apply tick are ordered by:

```text
(applyTick, inputClass, participantSlot, clientSequence, ingressSequence)
```

`inputClass` is a release-owned finite ordinal. Lifecycle safety records such as disconnect neutralization apply before ordinary player intent. Participant slots are server assigned. Client sequence is accepted only after monotonic validation. Ingress sequence is the final server-owned tie-break and can never override a lower participant slot or valid earlier client sequence.

The order-key integer profile is unsigned 32-bit and reserves its top values. Player-authored records use `participantSlot` in `0..9` and monotonic `clientSequence` in `0..4294967294`. A system control with no participant uses `participantSlot = 4294967294` (`0xfffffffe`) and `clientSequence = 4294967295` (`0xffffffff`); an administrative control with no participant uses `participantSlot = 4294967295` (`0xffffffff`) and the same missing-client sentinel `clientSequence = 4294967295`. These values are canonical replay data, not nullable fields. Participant-bound safety records use the affected participant's real slot, while their release-owned `inputClass` establishes safety precedence. In the paused-control tuple, the same system/admin `participantSlot` sentinels apply; the admission still carries the canonical missing-client sentinel even though `clientSequence` is not a paused-control sort component. Multiple unowned controls with otherwise equal keys are ordered only by their unique server-owned `ingressSequence`.

Held-control messages establish a complete reviewed control state. Discrete edges such as attack or interact can apply at most once. Multiple accepted updates for one participant in one tick are folded in canonical client-sequence order; the resulting state and every retained edge remain explicit in the admission ledger.

Input silence is measured from the last applied intent in completed ticks, never wall time. At the release-pinned timeout, the Engine deterministically emits and applies one neutralization safety event before ordinary intent; replay derives the same event without a synthetic client message.

### 7.4 System and membership records

Facts not generated by deterministic simulation but capable of changing it are recorded as bounded control records, including:

- disconnect and input neutralization;
- reconnect binding and safe-point restoration;
- grace expiry or all-absent pause;
- server-approved leave, abort, reset, or administrative stop;
- an in-segment checkpoint transition.

A transport callback does not mutate gameplay directly. It proposes one control record. During active play that record enters the next eligible tick under the canonical input-class order. While ticks are paused, records are sorted by `(completedTickOrdinal, controlClass, participantSlot, ingressSequence)` and one `control_commit_v1` seals each folded transition without advancing the tick. Content activation, boundary membership mutation, and restoration before a new segment are separate immutable receipts bound by the next segment header; they are never appended after the prior segment terminal.

## 8. Tick pipeline

Each active tick executes the following release-versioned phases in order:

1. **Input phase:** apply ordered safety/control records, neutralization, held controls, and discrete player edges.
2. **Timer phase:** advance tick-based status, cooldown, invulnerability, and lifecycle counters.
3. **AI phase:** evaluate enemies and queue actions in stable entity order.
4. **Intent phase:** derive legal player/enemy movement and attack intent from current authoritative state.
5. **Movement phase:** integrate bounded integer velocity and displacement in stable entity order.
6. **Collision phase:** resolve world and entity constraints with explicit contact/tie ordering.
7. **Combat phase:** open/close attack windows, construct authoritative hit candidates, then sort candidates by `(attackPhase, attackerId, attackInstanceId, targetId)`.
8. **Resolution phase:** commit hits, damage, resistance, knockback, invulnerability, death, and deterministic spawn/drop requests.
9. **World phase:** resolve pickups, checkpoints, objective progress, scoring, and progression.
10. **Lifecycle phase:** evaluate failure, completion, pause, reset, and terminal transitions.
11. **Commit phase:** apply sorted create/remove queues, append authoritative events, capture RNG state, canonicalize state, and seal digests.
12. **Publication phase:** derive bounded snapshots and telemetry from the completed tick.

A system may queue a later-phase effect but may not re-enter an earlier phase. Mutation during unordered iteration is prohibited. Any change to phase order, tie keys, or effect folding changes the tick-pipeline ID and therefore the Engine release.

## 9. Deterministic randomness

### 9.1 Algorithm

The vNext RNG profile is `xoshiro128ss-v1` (`xoshiro128**`) using four unsigned 32-bit state words and exact unsigned 32-bit rotate, shift, XOR, addition, and `Math.imul` semantics.

One draw performs:

```text
result = rotl32(imul(s1, 5), 7)
result = imul(result, 9) >>> 0
t = (s1 << 9) >>> 0
s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t
s3 = rotl32(s3, 11)
return result >>> 0
```

Every assignment is normalized with `>>> 0`. For a requested unsigned range `n` where `1 <= n <= 2^32`, range sampling computes `limit = floor(2^32 / n) * n`, draws until `value < limit`, then returns `value % n`; all operations use exact integer helpers. Modulo-biased sampling and hidden floating conversion are forbidden. Normative vectors for raw draws and boundary range cases are required before implementation acceptance.

### 9.2 Seed and stream derivation

Each replay segment records a 32-byte master seed. A live seed may be created with a cryptographic source only before the segment begins; the exact bytes become replay data. In replay JSON, `masterSeed` is exactly the lowercase hexadecimal encoding of those bytes: a 64-character string matching `^[0-9a-f]{64}$`, with two characters per byte in original byte order. Decoding converts each successive character pair to one byte before seed derivation. Uppercase, a `0x` prefix, whitespace, separators, odd length, any non-hex character, or any decoded length other than 32 bytes is invalid; an encoder must emit the unique lowercase form.

Independent stream state is derived from:

```text
SHA-256(
  "coin-rush/rng/v1\0" ||
  length-prefixed engineReleaseId ||
  length-prefixed contentRevisionDigest ||
  length-prefixed levelId ||
  length-prefixed streamKind ||
  length-prefixed stableOwnerId ||
  masterSeed
)
```

Every textual component is normalized UTF-8 preceded by its unsigned 32-bit big-endian byte length; the master seed is the final raw fixed-width 32 bytes. The first 16 digest bytes are read as four little-endian unsigned 32-bit words. If all four words are zero, `s3` becomes `1`. Stream kinds are a closed Engine allowlist. Dynamic owner streams may use only deterministically assigned stable IDs.

Separate streams isolate at least level generation/selection, entity AI, spawn selection, and drops when those systems use randomness. Adding, removing, or renaming a stream is an Engine-release change.

### 9.3 Consumption rules

- RNG calls occur only in reviewed pipeline phases and stable iteration order.
- A rejected input or failed precondition consumes no draw.
- A random branch consumes the exact documented number of draws regardless of presentation.
- Each stream’s state and draw count are included in canonical state.
- The Designer, browser, telemetry, asset decoding, logging, and snapshot scheduling have no access to simulation streams.

`Math.random()`, wall time, process ID, connection order, filesystem order, and external model output cannot seed or perturb active simulation.

## 10. Canonical replay format

### 10.1 Encoding

A replay segment is canonical UTF-8 NDJSON:

- one JSON object per line;
- RFC 8785 JSON Canonicalization Scheme bytes for each object;
- exactly one `\n` after every object, including the terminal object;
- no BOM, comments, blank lines, carriage returns, non-safe integers, duplicate keys, `NaN`, or infinities;
- bounded record count, line bytes, nesting, strings, arrays, and total bytes under separately reviewed budgets.

A parser treats replay bytes as untrusted data. Replay never carries executable code, arbitrary imports, arbitrary URLs, or paths to load outside the content-addressed registry.

### 10.2 Header

The first record is `segment_header_v1`. It binds at least:

- replay schema and digest algorithm IDs;
- complete Engine-release identity;
- protocol, mode, topology, session ID, segment index, and level ID;
- immutable content revision and manifest digest;
- tick rate, arithmetic profile, tick-pipeline ID, and RNG profile;
- `masterSeed`, the exact lowercase 64-hex encoding of the 32-byte master seed defined in Section 9.2;
- the pinned session-membership revision plus the separately ordered active-level participant IDs/slots and initial presence/absence state;
- objective/scaling/checkpoint revision digests;
- canonical initial-state digest and all initial RNG stream states;
- parent replay digest and boundary/checkpoint/activation/readiness receipt digests, or explicit genesis values. Party readiness receipts must bind fresh acknowledgement of this exact pinned content revision; readiness from a prior revision is invalid.

Private feedback, resume capabilities, IP addresses, secrets, raw prompts, and display names are excluded. Member identifiers in retained replay evidence are bounded server pseudonyms, not credentials.

### 10.3 Record kinds

After the header, only the closed replay-schema union is valid:

- `admission_v1`: one normalized accepted player intent or control record, with record sequence, ingress sequence, canonical order key, server-owned identity, and bounded payload; its closed schedule union contains exactly one active `applyTick` or one paused `completedTickOrdinal` plus control ordinal;
- `tick_commit_v1`: one completed tick with authority-commit sequence, consumed admission range, cutoff ingress sequence, ordered authoritative events, state digest, cumulative event digest, RNG digest, and tick digest;
- `control_commit_v1`: one ordered lifecycle transition while ticks are paused, with authority-commit sequence and completed tick unchanged plus the consumed control admission, ordered events, state digest, cumulative event digest, RNG digest, and control digest;
- `replay_checkpoint_v1`: a complete canonical technical state snapshot anchored to the latest authority-commit sequence (or explicit `genesis` before any commit), emitted immediately after ticks `249, 499, 749, ...`, after any control commit that enters pause or changes checkpoint state, and immediately before segment terminal;
- `segment_terminal_v1`: sealed result/failure/abort identity, final tick and digests, and next-lineage facts. Its `recordDigest` is the replay-segment digest; no self-referential digest field appears in its payload.

Every authoritative state mutation is sealed by exactly one tick commit or control commit. At most one technical checkpoint is emitted for one authority-commit sequence or the genesis anchor; coincident interval, pause, checkpoint-state, and terminal triggers coalesce. A technical replay checkpoint accelerates crash recovery and verification. It does not create a gameplay checkpoint, change session semantics, or become an alternative source of authority.

Network snapshots, render frames, packet timing, ping values, telemetry delivery, and diagnostic rejection records are not replay inputs.

### 10.4 Hash chain

The header digest is:

```text
SHA-256("coin-rush/replay-header/v1\0" || JCS(header without recordDigest))
```

For every later record `R`:

```text
recordDigest = SHA-256(
  "coin-rush/replay-record/v1\0" ||
  previousRecordDigest ||
  JCS(R without recordDigest)
)
```

Each record stores `previousRecordDigest` and `recordDigest` as lowercase 64-character hexadecimal strings. Hash calculations concatenate the decoded raw 32-byte prior digest, not its hexadecimal text. The terminal record’s `recordDigest` is the immutable replay-segment digest. Missing, duplicated, reordered, changed, appended-after-terminal, or truncated records fail verification.

## 11. State, event, RNG, and tick digests

### 11.1 Canonical state

Canonical state includes every fact capable of changing a later authoritative result, including:

- tick, phase, mode/topology, pinned content/level/objective/checkpoint identities;
- session-membership revision, ordered active-level participant IDs/slots, and presence/input state;
- deterministic entity state sorted by stable entity ID;
- movement/collision/combat/status/inventory/score/progression state;
- pending accepted admission references grouped by apply tick and pending stable create/remove/effect queues that survive a commit boundary;
- every RNG stream’s ID, four state words, and draw count;
- deterministic lifecycle and pause facts.

It excludes sockets, IPs, wall time, scheduler backlog, logs, metrics, network snapshot cadence, camera, audio, VFX, interpolation, decoded image state, and feedback text.

### 11.2 Per-commit seal

Every tick or paused lifecycle transition receives one monotonic unsigned `authorityCommitSequence` (`C`). At that commit the Engine produces:

```text
stateDigest = SHA-256("coin-rush/state/v1\0" || JCS(canonicalState))
eventBatchDigest = SHA-256("coin-rush/events/v1\0" || JCS(orderedEvents))
rngDigest = SHA-256("coin-rush/rng-state/v1\0" || JCS(orderedRngStates))
eventDigest[C] = SHA-256(
  "coin-rush/event-chain/v1\0" || eventDigest[C-1] || eventBatchDigest
)
authorityDigest[C] = SHA-256(
  "coin-rush/authority-commit/v1\0" ||
  u64be(C) || kindByte || u64be(completedTickOrdinal) ||
  authorityDigest[C-1] || stateDigest || eventDigest[C] || rngDigest
)
```

All digest operands after the domain separator are raw bytes. `kindByte` is `0x00` for a tick commit and `0x01` for a control commit. `completedTickOrdinal` is the last completed tick plus one, so `0` unambiguously means no tick has completed and tick `0` encodes as `1`. Let `headerRecordDigest` be the raw 32 bytes obtained by decoding the `segment_header_v1.recordDigest` lowercase hex value. Genesis is exactly:

```text
eventDigest[-1] = SHA-256(
  "coin-rush/event-chain-genesis/v1\0" || headerRecordDigest
)
authorityDigest[-1] = SHA-256(
  "coin-rush/authority-chain-genesis/v1\0" ||
  headerRecordDigest || eventDigest[-1]
)
```

The quoted domain strings are their exact UTF-8 bytes followed by one `0x00` byte; `headerRecordDigest` and `eventDigest[-1]` are raw 32-byte operands, never hexadecimal text. No zero digest, omitted operand, parent replay digest, or implementation default may substitute for these formulas.

A tick commit exposes `authorityDigest[C]` as its `tickDigest`; a control commit exposes it as its `controlDigest`. Empty event batches are explicit and still advance both chains. Thus every completed simulation tick has a digest, while lifecycle truth can also change safely during a pause without inventing a tick.

Authoritative events use stable IDs `(completedTickOrdinal, authorityCommitSequence, pipelinePhase, ordinal)` and canonical payloads. Telemetry may copy them, but telemetry transport cannot rewrite the sealed event order.

## 12. Replay verification

An authoritative verifier:

1. validates all byte/count/schema bounds and the complete record hash chain;
2. resolves the exact Engine release and immutable content bytes by digest without network fallback;
3. reconstructs the header’s canonical initial state and RNG streams;
4. feeds player admissions at their recorded apply ticks and applies paused control admissions only at their exact recorded ledger positions;
5. executes every tick through the exact pipeline without sockets, renderer, Designer, or wall-clock waits;
6. compares ordered events, state digest, cumulative event digest, RNG digest, and tick/control digest at every authority commit;
7. validates every technical checkpoint against the already reproduced state rather than loading it as corrective truth;
8. verifies the terminal result and replay-segment digest.

Verification stops at the first mismatch and reports a bounded divergence tuple: segment, tick, pipeline phase when known, expected/observed digest, Engine release, content revision, and RNG stream/draw count when relevant. It must not continue and call a later converged state valid.

A replay snapshot or event log never patches a divergent verifier back into agreement.

## 13. Crash recovery and atomic tick sealing

- Admission records are durable before their inputs can affect a tick or paused lifecycle transition.
- A tick or paused transition becomes authoritative only when its corresponding `tick_commit_v1` or `control_commit_v1` is durably sealed.
- A crash before authority commit restores the last technical checkpoint or initial state and replays sealed admissions through the last authority commit; the unsealed partial mutation has no authority.
- A crash after authority commit must read back the exact commit and must not reapply discrete edges or lifecycle controls.
- Recovery verifies content, Engine release, checkpoint state, ledger chain, and every replayed tick/control digest before accepting new input.
- Ambiguous, corrupt, missing, mismatched, or partially durable replay state fails closed. It cannot be repaired from a browser snapshot.
- A checkpoint is retained while referenced by an active session, replay lineage, accepted result, or rollback receipt.

Concrete file paths, fsync/rename operations, ownership, and retention budgets belong to implementation and file-protocol tasks, but they must satisfy these authority outcomes.

## 14. Segments, boundaries, checkpoints, and content

One active level pins one Engine release, content revision, level/objective identity, participant ordering, arithmetic profile, and master seed for its complete replay segment.

At a legal boundary:

1. the active segment seals its terminal result and replay digest;
2. telemetry and feedback refer to that sealed digest;
3. any content activation/rollback decision produces its separate immutable receipt;
4. the next segment header binds the prior replay digest plus boundary, content, and checkpoint receipts;
5. the next segment pins its own revision, seed, objective, participants, and initial-state digest before tick 0.

A candidate arriving mid-level cannot change the current header, RNG, state, events, assets, or result. Replaying an older segment uses its pinned content even if the registry now points to a newer active revision.

A gameplay checkpoint restoration starts from one complete checkpoint defined by `td-ac4b.4.13` and binds its digest in the next replay lineage. It never combines partial state from multiple revisions or accepts client state.

## 15. Single-player and multiplayer invariants

The same clock, arithmetic, RNG, pipeline, ledger, and verifier apply to solo and two-to-ten-player sessions.

- Solo does not use a local/browser clock or hidden client simulation.
- Party same-tick input is ordered by server slot, not socket callback timing or display name.
- Disconnect neutralization is a control record and cannot leave held input active.
- An absent campaign-party participant cannot collide, attack, take damage, block objectives, vote, or change active player-count scaling.
- Rejoin binds the same server member/slot at the checkpoint contract’s deterministic safe point and introduces no client-authored state.
- All-absent or solo disconnect pause stops ticks exactly at a completed boundary.
- `coin-race-v1` disconnect-to-lobby, winner, and timed-reset behavior remain reproducible control/lifecycle outcomes under its compatibility contract.
- Separate sessions have separate seeds, ledgers, entity counters, RNG streams, and replay lineage. No global mutable RNG or entity counter may couple them.

A ten-player run and an unrelated solo run must produce the same individual digests whether hosted alone or interleaved on one process, given their respective ledgers.

## 16. Presentation, networking, telemetry, and Designer isolation

The following may vary without changing authoritative digests:

- browser frame rate, viewport, device pixel ratio, reduced motion, animation speed, or input device;
- snapshot frequency, packet batching, latency, retransmission, coalescing, or slow-consumer drops after authoritative admission;
- camera, interpolation, pose timing, particles, flashes, audio, and other VFX;
- telemetry export cadence, logging, metrics, and replay upload timing;
- Designer, annotator, image generator, or network availability.

Five-pose presentation (`idle`, `move`, `attack`, `hit`, `death`) follows authoritative state; animation callbacks never create simulation events or RNG draws.

Designer output can affect only a future segment after separate content validation and atomic activation. The actual Designer never runs inside replay verification.

## 17. Required acceptance evidence

Implementation cannot claim this contract from documentation alone. Acceptance requires automated evidence for at least:

1. The same exact release/content/header/ledger reproduces identical per-tick state, event, RNG, tick, checkpoint, terminal, and replay digests across repeated runs.
2. The same immutable release image reproduces those digests on two independent hosts under different CPU load and scheduler cadence.
3. Solo, two-player, and ten-player fixtures reproduce; an unrelated interleaved session cannot perturb their IDs, RNG, or digests.
4. Normative `xoshiro128ss-v1`, seed-derivation, rejection-sampling, fixed-point conversion, rounding, and digest test vectors pass.
5. Static/runtime guards reject authoritative use of `Math.random()`, wall time, variable delta, unquantized float state, unordered enumeration, and presentation callbacks.
6. Permuting an already admitted same-tick batch produces the same canonical application order and result; changing a recorded apply tick or valid sequence changes the expected digest.
7. Input arriving immediately before and after a tick cutoff lands in the recorded tick with no double apply or loss.
8. Stale, duplicate, malformed, authority-bearing, over-rate, and rejected inputs produce zero state/event/RNG/tick mutation.
9. Disconnect, neutralization, solo pause/rejoin, party continue/rejoin, all-absent pause, grace expiry, and `coin-race-v1` abort/reset replay exactly.
10. Catch-up execution, omitted intermediate network snapshots, and operational overload stall/resume preserve every authoritative digest and add no gameplay commit; no tick is merged or skipped.
11. Alternate browser frame rates, viewports, reduced motion, missing cosmetics, disabled VFX, and network snapshot cadence leave authoritative digests unchanged.
12. AI, collision, simultaneous attacks, multi-target hits, deaths, drops, pickups, and objective ties prove stable entity/contact/effect order.
13. A candidate arriving during play cannot alter the segment; the next segment binds exactly the accepted activation or last-known-good receipt.
14. Replaying a superseded but retained content revision succeeds by digest without using the current active pointer or network fetch.
15. Crash before tick commit discards partial mutation; crash after commit does not replay an edge twice; recovery reaches the same final digest.
16. Technical checkpoint loading is verified against replayed state and cannot conceal an earlier divergence.
17. Corrupt, truncated, reordered, duplicated, appended-after-terminal, oversized, unknown-schema, wrong-engine, wrong-content, and wrong-parent ledgers fail closed.
18. A long-run fixture crosses integer, entity-ID, counter, checkpoint, and RNG boundaries without overflow or platform divergence.
19. Replay evidence excludes secrets, resume capabilities, IP addresses, raw feedback, prompts, and arbitrary external references.
20. The accepted production baseline remains byte-identical and independently playable throughout contract implementation.

Existing `td-ac4b.1.2` and `.1.3` evidence supports baseline compatibility only. It does not prove vNext fixed-point arithmetic, AI/combat ordering, RNG, replay persistence, crash recovery, content lineage, or cross-host reproduction.

## 18. Prohibited designs

The following violate this contract:

- variable-delta or browser-driven authoritative simulation;
- skipping, merging, stretching, or silently fast-forwarding ticks under load;
- simulation use of client timestamps, local time, `Date.now()`, `Math.random()`, process identity, or filesystem/network iteration order;
- floating animation/camera/asset values feeding collision, combat, AI, or progression;
- client-selected tick, seed, RNG output, entity ID, order key, content revision, or replay result;
- one global RNG stream shared across systems or sessions;
- consuming RNG on failed guards or rejected input;
- using network snapshots or technical checkpoints to patch over replay divergence;
- replay formats with executable data, arbitrary paths/URLs, permissive unknown fields, unbounded records, or mutable external dependencies;
- omitting disconnect, expiry, pause, resume, checkpoint, or boundary facts that can change simulation;
- certifying a replay against a different or dirty Engine release;
- deleting content/checkpoint bytes still referenced by sealed replay evidence;
- claiming deterministic replay because two final scores match while intermediate state/event/RNG digests differ.

## 19. Explicit non-goals

This contract does not:

- implement the Engine loop, replay writer/verifier, storage, checkpoint system, or browser UI;
- define final wire-message field names beyond authoritative admission requirements;
- define matchmaking, accounts, public replay sharing, spectator mode, or anti-cheat adjudication;
- decide discrete levels versus any future endless-streaming product mode; tonight’s accepted graph uses bounded active-level segments, and a streaming proposal would require separately reviewed deterministic segment boundaries;
- promise replay compatibility across different Engine releases;
- choose filesystem directory names, lock files, fsync sequence, retention duration, compression, or archive service;
- define content candidate lifecycle or atomic inbox/outbox mechanics owned by `td-ac4b.2.5` and `.2.6`;
- run or ship the actual Designer, annotator, model, prompt, or image-generation service;
- mutate runtime, production, PR #2, PR #3, or the accepted `5294147` release;
- authorize deployment before downstream implementation and independent acceptance gates pass.

## 20. Consequences

- Authoritative bugs can be reproduced at the first divergent tick rather than inferred from browser video or final score.
- Fixed-point state, explicit sort keys, isolated RNG streams, canonical ledgers, and per-tick seals add implementation cost but remove major platform and scheduling ambiguity.
- Replay files become security-sensitive untrusted artifacts requiring strict bounds and content retention, but they contain no credentials or raw private feedback.
- Gameplay pauses are explicit ledger facts; overload is explicit operational evidence and never hidden gameplay authority.
- Solo and multiplayer share one deterministic Engine contract.
- Content activation remains between levels and every level result stays bound to the exact revision that produced it.
- Production remains frozen until this documentation contract is implemented and independently proven through the downstream TD dependency chain.
