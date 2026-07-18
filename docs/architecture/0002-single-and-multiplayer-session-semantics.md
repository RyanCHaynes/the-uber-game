# ADR 0002: Single-player and multiplayer session semantics

- **Status:** Accepted design contract; implementation remains gated on baseline freeze
- **Date:** 2026-07-18
- **TD task:** `td-ac4b.2.2`
- **Depends on:** [ADR 0001](0001-vnext-engine-and-designer-boundary.md)
- **Review base:** `fc39b53acdb2032ab4f542a0daf1e3b7f6def878`
- **Production baseline:** `52941476f9af110df9be0b3a0a118d4b76c38e0a`

## Context

Coin Rush vNext must be completely playable by one person while retaining authoritative two-to-ten-player play. “Single-player support” cannot mean spawning a bot, waiting in a multiplayer lobby, or silently weakening server authority. At the same time, adding solo play cannot break the accepted multiplayer coin-race baseline or create ambiguous transitions when players join, ready, leave, reconnect, finish a level, or wait for new content.

This contract defines session-level product semantics. It does not define wire encodings, combat tuning, schema field names, reconnect durations, matchmaking, account identity, or deployment topology. Those details belong to the follow-on protocol, runtime, content, and operations tasks.

## Normative vocabulary

- **Session:** One isolated authoritative game lifecycle with a pinned mode and topology, a current phase, and a server-owned membership registry whose mutations are boundary-only. Each active level separately pins its ordered participant set, content revision, seed, and objective.
- **Mode:** The ruleset: `campaign` or compatibility mode `coin-race-v1`.
- **Topology:** The entry contract: `solo` or `party`. Topology is explicit; the server does not infer it from the number of open sockets.
- **Joined player:** A connection that completed the accepted server handshake and owns a server-assigned identity and slot.
- **Present player:** A joined player with a currently bound live connection.
- **Ready player:** A present party player who acknowledged the exact mode, content revision, and next transition.
- **Boundary:** A lobby, checkpoint, level-complete, or between-level phase where membership or content may safely change.
- **Active level:** A simulation interval with immutable mode, content revision, seed, objective, and ordered participant slots.

“Must” and “must not” are acceptance requirements.

## Decision

### 1. Supported mode and topology matrix

| Mode | Topology | Players required to start | Start gate | Outcome |
| --- | --- | ---: | --- | --- |
| `campaign` | `solo` | exactly 1 | immediate after accepted setup; no ready gate | level/campaign success or failure |
| `campaign` | `party` | 2–10 | every joined player ready | shared level/campaign success or failure |
| `coin-race-v1` | `party` | 2–10 | every joined player ready | first player to the server winning score |
| `coin-race-v1` | `solo` | invalid | rejected before session creation | none |

The final vNext product defaults to `campaign`. `coin-race-v1` is a compatibility ruleset that preserves the accepted multiplayer behavior and rollback path; it is not used to simulate solo PvE.

A UI action must select topology explicitly:

- **Play Solo** creates or resumes `campaign` + `solo`.
- **Create/Join Party** enters `campaign` + `party`.
- **Classic Coin Race**, while retained, enters `coin-race-v1` + `party`.

A session never changes mode or topology during an active level. A party that falls to one present player remains a party session; it does not restart or silently become a new solo session.

### 2. Single-player is immediate and complete

A valid solo campaign setup creates one server-owned player and begins the active level as soon as required content is validated and pinned by the server. It must not:

- wait for another human;
- create or require a bot;
- expose a ready button as a start dependency;
- call the Designer, annotator, image generator, or any external service;
- depend on another session existing;
- weaken input, collision, combat, progression, or content validation.

Solo and party campaign play use the same fixed-step authoritative simulation, enemy primitives, level/objective rules, content registry, and snapshot semantics. Differences are limited to membership, readiness, disconnect handling, presentation, and any explicitly schema-bounded player-count scaling.

### 3. Party readiness and start

A party may wait in a lobby with one joined player, but it cannot start until 2–10 players are joined and all are ready.

Readiness is server state, not a client assertion about the overall room. The server evaluates the start predicate after every accepted ready change, join, disconnect, or membership removal. A newly joined player is unready and therefore invalidates a pending start. Ready state resets after a round abort, level failure, return to the lobby, or membership-changing boundary.

Every newly pinned next-level content revision also resets all party ready states. Each present party member must explicitly acknowledge that exact revision before the next active level starts; a `ready=true` value from an earlier revision can never satisfy the new all-ready gate.

The server assigns unique stable slots from `0` through `9`. It rejects an eleventh connection before it becomes joined. Names are display data and never identity.

### 4. Membership changes are boundary-controlled

| Phase | New party join | Solo second join | Rejoin | Voluntary leave |
| --- | --- | --- | --- | --- |
| setup/lobby | allowed through validation | rejected | allowed | removes membership |
| active level | rejected as a new member | rejected | allowed only for a reserved member | handled by mode disconnect rules |
| level complete / between levels | allowed before the next revision is pinned | rejected | allowed | removes membership before next level |
| campaign complete / closed | new session required | new session required | rejected | closes connection |

No new participant may appear mid-level. A between-level join receives the next pinned revision and cannot affect the completed level’s result, feedback, telemetry, or replay digest.

The routing or matchmaking mechanism that locates a session is outside this contract. Regardless of whether a deployment hosts one session or many, state and identities from different sessions must never mix.

### 5. Disconnect and rejoin semantics

All disconnect handling is server-owned. A reconnect proves possession of an opaque server-issued resume capability; it never submits replacement position, health, score, inventory, objective, content, or simulation state.

#### Solo campaign

- Losing the only connection pauses authoritative advancement at a deterministic tick boundary.
- The server reserves the member and session for a bounded configured grace period.
- A valid rejoin binds to the same member, slot, pinned revision, and server-owned state.
- If grace expires, the server commits only the last valid checkpoint and closes or suspends the session according to the checkpoint contract. It does not manufacture unobserved play.
- Resume after expiry starts from that committed checkpoint, never from client state or an arbitrary partial frame.

#### Party campaign

- A disconnected member becomes absent, produces neutral input, and cannot collide, attack, take damage, block an objective, or vote during absence.
- The slot and authoritative member state remain reserved for the bounded grace period.
- Remaining present players continue, even if only one remains; an ordinary disconnect does not abort their campaign level.
- A valid in-grace rejoin restores the same member and slot from server state at a deterministic safe point.
- After grace expires, the absent member is deterministically removed or checkpointed. A later return is a boundary join, not a mid-level rejoin.
- If no present players remain, simulation pauses at a deterministic tick boundary and follows the all-absent checkpoint/expiry rule.

#### `coin-race-v1`

The accepted baseline behavior remains exact: any active-player disconnect aborts that round, clears active round state, resets readiness, and returns remaining joined players to the lobby with an authoritative notice. This compatibility mode does not inherit campaign continuation semantics.

Exact grace durations, capability format, checkpoint payload, and safe-point selection are defined by `td-ac4b.4.13`; they must satisfy these outcomes.

### 6. Level, failure, and between-level lifecycle

Campaign phases are:

```text
setup -> [lobby for party] -> active-level -> level-complete
      -> feedback-window -> between-level -> next active-level
      -> campaign-complete -> closed
```

A failed level transitions through a deterministic failure/checkpoint rule and never activates unvalidated content. Content defines objectives only through allowlisted bounded primitives. The server alone decides whether an objective, failure condition, checkpoint, or campaign end is satisfied.

At level completion the server:

1. stops gameplay mutation at an authoritative tick;
2. seals the result and replay/event digest;
3. writes bounded telemetry and requests per-player feedback;
4. opens a bounded feedback/candidate window;
5. validates any candidate without changing completed-level truth;
6. pins either one complete accepted next revision or last-known-good content;
7. starts the next level under the applicable solo-immediate or party-ready gate.

Missing feedback, an absent annotator, a late Designer candidate, failed image generation, or any external timeout must not prevent continuation with known-good content.

Party feedback is per player. Missing or disconnected players time out independently and do not block the next level forever. Joining players cannot submit feedback for a level they did not play.

### 7. Campaign completion, score, and winner semantics

Campaign is cooperative PvE. It has authoritative per-player statistics and may expose schema-bounded score values, but it does not declare a competitive `winnerId` merely because one player contributed the most. A campaign level ends when its validated shared objective or failure condition is satisfied. A campaign ends when the pinned progression graph reaches an accepted terminal success or failure.

Player-count scaling, if enabled, is derived once from the ordered joined slots and bounded content rules when a level starts. It cannot be changed by a client or regenerated mid-level. A disconnect does not silently rescale active enemy health, damage, drops, or objective quotas.

`coin-race-v1` retains individual score, first-to-target winner, winner notice, timed round reset, and return-to-lobby semantics from the accepted baseline.

### 8. Death and checkpoint invariants

Detailed health, hurt, death, respawn, and checkpoint mechanics are implemented under `td-ac4b.4.4` and `td-ac4b.4.13`, but every implementation must obey these session rules:

- client death is never equivalent to connection loss;
- a dead or absent player cannot emit effective gameplay input;
- solo death cannot require another player to continue;
- one party member’s death cannot by itself fabricate victory or alter another member’s authority;
- all-player failure and checkpoint restart occur at deterministic server transitions;
- checkpoints pin engine version, content revision, seed, objective state, ordered player state, and replay/event digest lineage;
- checkpoint restoration rejects mismatched or partial revisions.

### 9. Authority and deterministic ordering

Every session pins for its lifetime:

- protocol and engine version;
- mode and topology.

Every session owns one server-side membership registry. Membership may change only at a boundary, and each accepted mutation increments the registry's monotonic revision.

Every active level separately pins:

- the exact membership revision and ordered participant IDs and slots selected at the level boundary;
- immutable content revision and digest;
- seed and fixed-step clock origin;
- objective and checkpoint revision.

The server processes same-tick player actions in stable slot order unless the deterministic simulation contract defines another recorded ordering. Snapshots identify session phase, mode, topology, membership revision, per-level participant set, content revision, seed/replay lineage, and authoritative members. Cosmetic rendering and interpolation never alter these values.

The exact protocol fields remain the responsibility of `td-ac4b.2.3` and the replay/clock rules of `td-ac4b.2.4`.

### 10. Compatibility and migration

- Baseline `5294147` remains deployed and unchanged until all replacement gates pass.
- Legacy clients can participate only in the compatible `coin-race-v1` protocol. They fail closed when offered campaign semantics they do not understand.
- A session cannot mix legacy and vNext message semantics.
- No migration may reinterpret an in-progress baseline room as a campaign session.
- Rollback restores a complete compatible engine/client/content set, not selected files.
- Existing two-to-ten slot uniqueness, all-ready start, eleventh rejection, authoritative movement, score-to-five, win/reset, and disconnect-to-lobby behavior remain acceptance requirements for `coin-race-v1`.

## State-transition table

| Current state | Event | Guard | Next state / effect |
| --- | --- | --- | --- |
| solo setup | accepted player + pinned content | exactly one member | active level immediately |
| party lobby | ready change/join/leave | 2–10 joined and all ready | active level |
| party lobby | ready change/join/leave | start guard false | remain lobby |
| active campaign | valid member disconnect | at least one present remains | continue with absent member semantics |
| active campaign | all members absent | none present | deterministic pause/grace |
| active campaign | valid rejoin | member reserved | bind same member/slot at safe point |
| active coin race | member disconnect | round running | abort round; reset to lobby |
| active level | objective satisfied | server validation true | level complete |
| active level | failure satisfied | server validation true | deterministic failure/checkpoint path |
| feedback window | feedback/candidate deadline | deadline or all accepted inputs | between level |
| between level | accepted candidate | validation/dry run pass | atomically pin candidate |
| between level | absent/late/rejected candidate | no complete accepted candidate | pin last-known-good |
| between level | start gate satisfied | solo immediate or party all-ready | next active level |
| terminal progression | terminal objective | sealed result | campaign complete |

## Required acceptance matrix

Implementation cannot close this contract without automated and real-client evidence for at least:

1. Solo campaign starts with one browser, no ready action, no second socket, and no bot.
2. A second member cannot enter a solo session.
3. A one-member party lobby waits; 2–10 all-ready members start exactly once.
4. A newly joined unready party member prevents start; every newly pinned next-level revision resets all ready states and requires fresh acknowledgement; the eleventh member is rejected.
5. New membership is rejected during an active level and accepted only at a boundary.
6. Solo disconnect pauses; valid rejoin restores the same server-owned slot and state.
7. Party campaign disconnect leaves remaining players active; in-grace rejoin restores identity without accepting client state.
8. All-absent party behavior pauses deterministically and expires through the checkpoint rule.
9. `coin-race-v1` disconnect still aborts the round and returns remaining players to an unready lobby.
10. Campaign completion reports shared success/failure without a competitive winner; coin race still reports its winner.
11. Solo and party runs with the same recorded inputs, seed, content, and membership events reproduce identical digests on replay.
12. Active content and scaling remain pinned through disconnects, rejoin, feedback, and late candidate arrival.
13. Missing feedback, Designer, annotator, image generator, or network access does not block known-good continuation.
14. Legacy protocol clients fail closed rather than entering a partially understood campaign session.
15. Browser focus loss and disconnect cannot leave held input active for a paused, absent, dead, or rebound player.

## Explicit non-goals of this contract

This document does not:

- implement the actual Designer agent;
- define matchmaking, accounts, public room discovery, or how many sessions a host runs;
- choose combat numbers, grace-period duration, checkpoint frequency, or content schema field names;
- permit bots to satisfy solo or multiplayer minimums;
- convert campaign into competitive PvP;
- permit mid-level joins, content swaps, or dynamic player-count rescaling;
- remove or mutate the accepted production baseline;
- authorize a deployment before the baseline freeze and downstream acceptance chain complete.

## Consequences

- Solo play is a first-class server-authoritative path, not a special client simulation.
- Campaign parties survive ordinary disconnects instead of inheriting coin-race round-abort behavior.
- The compatibility coin race remains testable and reversible while campaign implementation develops.
- Explicit topology prevents accidental starts when a player intended to wait for a party.
- Rejoin and between-level behavior require more server state, but every transition is bounded and replayable.
- Follow-on protocol, runtime, client, schema, and acceptance tasks can implement against one unambiguous session contract.
