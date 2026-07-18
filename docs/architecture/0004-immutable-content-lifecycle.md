# ADR 0004: Immutable content lifecycle and between-level activation

- **Status:** Accepted design contract; implementation remains gated on baseline freeze
- **Date:** 2026-07-18
- **TD task:** `td-ac4b.2.5`
- **Depends on:** [ADR 0001](0001-vnext-engine-and-designer-boundary.md)
- **Review base:** `fc39b53acdb2032ab4f542a0daf1e3b7f6def878`
- **Production baseline:** `52941476f9af110df9be0b3a0a118d4b76c38e0a`

## Context

Coin Rush vNext consumes bounded JSON and PNG content that may be produced by an external Designer, a human, or a deterministic fixture. The producer is untrusted and optional. A malformed, late, stale, partial, or failed proposal must never mutate an active level or damage the last-known-good content.

This contract defines content revision identity, lifecycle states, activation boundaries, fallback, and rollback. It deliberately does not choose filesystem paths, lock files, byte budgets, schema field details, validation algorithms, or threat mitigations; those belong to `td-ac4b.2.6` through `td-ac4b.2.8` and the schema/runtime tasks.

“Must” and “must not” are acceptance requirements.

## Normative vocabulary

- **Content set:** One complete manifest plus all referenced enemy, attack, level, pose metadata, and PNG assets required for a revision.
- **Revision:** An immutable content set identified by a canonical manifest digest. A revision is complete or it does not exist.
- **Candidate:** An untrusted proposed revision addressed to one expected base revision and one eligible future activation boundary.
- **Registry:** Engine-owned durable records of revision states, digests, validation receipts, activation decisions, and rollback lineage.
- **Active revision:** The complete validated revision selected as the default last-known-good revision for eligible future level starts.
- **Pinned revision:** The immutable active revision a session captured for one active level. A session pin cannot change until that level ends.
- **Boundary:** A server-owned point after a level result is sealed and before the next level’s revision, seed, objective, and participants are pinned.
- **Cutoff:** The recorded boundary event after which a candidate is too late for that boundary.
- **Dry run:** A bounded engine validation pass that loads the entire content set and exercises publication/startup invariants without changing the active pointer.
- **Rollback revision:** The previously active complete revision retained byte-for-byte as the immediate recovery target.

## Revision identity and immutability

Every candidate manifest must bind at least:

- content schema version;
- canonical revision digest and revision ID;
- expected base revision digest;
- target scope and target boundary ID;
- engine/protocol compatibility range;
- complete ordered file inventory with media type, byte size, and digest;
- generation or authorship provenance sufficient for receipts;
- bounded attempt number or idempotency key.

The manifest digest is computed from canonical manifest bytes that bind every referenced file digest. Revision identity does not depend on a mutable filename, directory name, timestamp, or producer claim.

After the engine observes a complete candidate, its bytes are immutable. A correction is a new candidate attempt and digest. The engine never edits, repairs, fills in, renames fields inside, or silently normalizes an untrusted content set into acceptance. Deterministic image normalization produces a separately digested candidate artifact before lifecycle validation.

Any digest collision, inventory mismatch, duplicate path, mutable reread, or post-receipt byte change rejects the candidate.

## Lifecycle states

| State | Meaning | May become |
| --- | --- | --- |
| `candidate` | Complete untrusted proposal atomically offered to the engine; no trust is implied | `validating`, `rejected` |
| `validating` | Engine holds immutable candidate bytes while bounded structural, semantic, asset, compatibility, budget, and dry-run checks execute | `validated`, `rejected` |
| `validated` | Every required check passed against the recorded engine version and expected base; candidate is not yet selectable | `staged`, `rejected` |
| `staged` | Complete validated revision and activation receipt are durably prepared for one matching future boundary | `active`, `rejected` |
| `active` | Registry points to this complete revision as last-known-good for eligible future level pins | `active` as idempotent replay, `superseded` after a successful newer activation, or `rolled-back` if this revision itself fails after activation |
| `superseded` | Previously active complete revision retained as history or possible rollback target after a newer revision became active | `active` through an explicit rollback transaction, or `rolled-back` if a still-pinned session proves the revision defective |
| `rejected` | Terminal state for one candidate digest/attempt with machine-readable reasons; it was never active | none |
| `rolled-back` | Terminal state for a revision that became active and was then removed from active selection because activation/startup or later pinned use failed | none; a correction is a new revision |

`rejected` and `rolled-back` are not interchangeable. Rejected bytes were never authoritative. Rolled-back bytes were validated and briefly active but are no longer eligible for automatic selection. During rollback, the failed revision becomes `rolled-back` and the retained `superseded` last-known-good revision becomes `active` in one recorded transaction.

A superseded or rolled-back revision remains immutable in history. State metadata and receipts change; revision bytes do not.

## State-transition rules

### Candidate to validating

The engine observes a candidate only after the producer has completed the file-protocol publication operation defined by `td-ac4b.2.6`. Partial writes and temporary files are invisible.

Before validation begins, the engine verifies that the candidate:

- is addressed to the current expected base digest;
- targets a known future boundary and allowed scope;
- has a supported schema/engine compatibility range;
- has not already reached a terminal state under the same digest/idempotency key;
- arrived before the recorded cutoff for that target boundary;
- is complete enough to enumerate without following unsafe references.

A duplicate identical candidate returns the prior receipt idempotently. A duplicate key with different bytes rejects as an identity conflict.

### Validating to validated

Validation is fail-closed and covers the complete set before any staging side effect. It includes, at minimum:

1. manifest and canonical digest verification;
2. safe bounded file inventory verification;
3. JSON schema and unknown-field rejection;
4. semantic references and allowlisted behavior primitives;
5. PNG format, dimensions, palette/alpha, digest, and decompression bounds;
6. level geometry, spawn, objective, and bounded solvability checks;
7. engine/protocol compatibility;
8. deterministic dry-run load and next-level startup;
9. runtime/content budgets;
10. stale base, target boundary, and attempt checks.

Every check produces a versioned receipt. A timeout, crash, unavailable validator, ambiguous result, or non-deterministic disagreement is a rejection, not a warning or partial pass.

### Validated to staged

Staging durably assembles one complete revision and an activation intent without changing the active pointer. The engine rereads and verifies staged bytes and digests from the location that activation will use.

Staging fails closed if any referenced file is missing, mutable, replaced, symlinked outside its allowed root, incompatible, or different from validation. Failure leaves the previous active pointer and rollback revision unchanged.

At most one candidate can occupy an activation slot for a target boundary. Correction attempts replace no bytes. When the engine atomically observes a complete candidate, it assigns and records a monotonic receipt sequence. At cutoff, eligible candidates are ordered by bounded attempt number descending, receipt sequence ascending, then revision digest ascending; the first entry wins. The activation receipt records the complete selection key and eligible digest set so replay makes the same choice. Every non-selected attempt becomes `rejected` with `activation_slot_filled`. Exact queue and filesystem mechanics are defined by `td-ac4b.2.6`.

### Staged to active

Activation is legal only when all of the following are true:

- the authoritative level result and replay/event digest are sealed;
- no level is executing under a mutable content handle;
- the feedback/candidate cutoff for the target boundary is recorded;
- the staged candidate still matches its expected base and target boundary;
- all validation and dry-run receipts remain valid for the running engine version;
- the complete previous active revision is retained as rollback revision;
- the next level has not accepted its first authoritative simulation tick.

The engine performs one atomic registry transaction that records the prior active digest, selected staged digest, boundary ID, decision inputs, and new active pointer. A session then pins that complete revision before it pins seed, objective, participants, and replay lineage.

An active session retains its existing pinned revision even if another session reaches a boundary and activates a newer revision. No global publication event may change content underneath an active level.

Activation of the same revision for the same boundary is idempotent and returns the original receipt. A conflicting second activation decision rejects.

### Active or superseded to rolled-back

A failure detected after the activation decision but before the next level’s first authoritative tick executes a new atomic rollback transaction: the failed newly active revision becomes `rolled-back`, the retained prior safe `superseded` revision becomes `active`, and the registry records reason, engine version, and boundary.

After the first authoritative tick, content is pinned. The engine must not hot-swap or roll back files underneath the active level. A fatal content defect ends or suspends that level through deterministic session rules and seals the failure evidence. If the defective revision is still the registry’s `active` revision, the engine marks it `rolled-back` and restores a safe superseded revision only at the next legal boundary. If another session already made a newer revision active, the defective older `superseded` revision becomes `rolled-back` at that session’s next legal boundary while the newer active pointer remains unchanged.

Rollback may restore only a complete previously active `superseded` revision whose bytes and digest reverify and which has no defect or rolled-back receipt. It never combines old and new files. If the immediate rollback revision is defective or fails verification, the engine fails closed and selects another separately retained known-good revision only through an explicit recovery receipt; it does not guess or repair.

## Between-level activation sequence

```text
active level on revision A
  -> seal result, telemetry, and replay digest for A
  -> open bounded feedback/candidate window
  -> record cutoff
  -> choose one complete eligible candidate for base A
  -> validate and dry-run candidate B
  -> stage B; retain complete A as rollback
  -> atomically record A -> B activation
  -> pin B + seed + objective + participants for next level
  -> accept first authoritative tick on B
```

Any absent, late, stale, rejected, timed-out, or failed candidate follows instead:

```text
seal level on A -> record no-activation/rejection receipt -> pin A again
```

Revision A remains byte-identical in both paths.

## Late, stale, and concurrent candidates

- A candidate arriving after its target cutoff is `rejected` as `late_candidate`; it cannot delay the boundary or become active retroactively.
- A candidate whose expected base digest does not equal the boundary’s active base is `rejected` as `stale_base`.
- A candidate targeting an unknown, completed, or mismatched boundary is `rejected` as `invalid_target_boundary`.
- A candidate generated from telemetry or feedback for a different session/scope is `rejected` as `scope_mismatch`.
- A candidate still validating when the boundary cutoff is recorded becomes terminal `rejected` with `late_candidate`; it has no activation path for that or any later boundary. A producer must submit a newly manifested candidate targeting a later boundary. Last-known-good continues.
- If several candidates are offered, the recorded attempt/receipt-sequence/digest ordering selects no more than one. Arrival races and wall-clock scheduling cannot produce two active revisions for one boundary or a different winner on replay.
- A newer candidate never invalidates an already pinned active level.

The actual Designer, annotator, image generator, and network availability are irrelevant to these outcomes.

## Crash recovery and durability invariants

The filesystem protocol will provide the concrete atomic rename, ownership, lock, and fsync mechanics. Regardless of implementation:

- registry state must distinguish prepared/staged activation from committed active activation;
- restart after an incomplete staging operation preserves the old active pointer;
- restart after an activation commit resolves to either the complete old revision or complete new revision according to the durable commit record, never a mixture;
- an orphan candidate or staging directory has no authority without a matching registry record;
- replaying the same candidate, validation receipt, or activation transaction is idempotent;
- active and immediate rollback revisions remain retained and read-only;
- garbage collection cannot remove bytes referenced by an active session, rollback pointer, sealed replay, pending receipt, or accepted release receipt.

## Rejection and rollback receipts

Every terminal decision records a bounded machine-readable receipt containing:

- candidate and revision digest;
- expected and observed base digest;
- target scope and boundary ID;
- engine, protocol, schema, validator, and art-profile versions;
- lifecycle transition attempted;
- stable reason code plus bounded human-readable detail;
- ordered validation checks and outcomes;
- prior and resulting active digest;
- decision sequence/tick and receipt digest;
- provenance reference without secret or untrusted prompt disclosure.

Minimum stable reason-code families include:

- `manifest_invalid`, `digest_mismatch`, `inventory_invalid`;
- `schema_unsupported`, `schema_invalid`, `unknown_field`;
- `unsafe_path`, `unsafe_file_type`, `asset_invalid`;
- `budget_exceeded`, `semantic_invalid`, `dry_run_failed`;
- `late_candidate`, `stale_base`, `invalid_target_boundary`, `scope_mismatch`;
- `attempt_conflict`, `activation_slot_filled`, `engine_incompatible`;
- `staging_failed`, `activation_failed`, `rollback_failed`, `validator_unavailable`.

A receipt never turns a failed candidate into a warning-level activation.

## Required invariants

1. Exactly one complete active revision exists for each registry scope.
2. Every active level pins one immutable revision digest before its first tick.
3. An active-level pin never changes mid-level.
4. Only engine-owned validation and registry transitions can make a candidate active.
5. The producer cannot write into active or rollback storage.
6. A candidate is never partially validated, staged, activated, or rolled back.
7. Rejection, timeout, absence, lateness, staleness, and crash preserve last-known-good bytes and pointer.
8. Activation and rollback are complete-set transactions, never file-by-file swaps.
9. The prior complete active revision remains available through activation and startup acceptance.
10. Completed-level telemetry, feedback, result, and replay truth remain bound to the revision that produced them.
11. A candidate cannot affect a level it was generated from.
12. Content availability cannot block a clean level finish or known-good continuation forever.

## Required acceptance matrix

Implementation cannot close this contract without automated evidence for at least:

1. A complete valid candidate follows `candidate -> validating -> validated -> staged -> active` only at a boundary.
2. The same candidate and activation operation replay idempotently with the same receipts.
3. Partial writes and incomplete inventories are never observed as candidates.
4. A malformed JSON file, invalid PNG, bad digest, unsafe path, unknown field, unsupported primitive, or over-budget file rejects the complete candidate.
5. Rejection leaves active pointer and active/rollback bytes unchanged.
6. A late candidate does not delay or alter the next level; last-known-good starts.
7. A stale-base or wrong-boundary candidate rejects even when its files are otherwise valid.
8. A validator timeout/crash/unavailable dependency rejects or misses the slot without changing active content.
9. Two concurrent candidate attempts produce one selection from the recorded attempt/receipt-sequence/digest key; replay with the same receipt ledger chooses the same digest and produces no mixed revision.
10. Crash before activation commit restores the prior active revision.
11. Crash after activation commit resolves to one complete revision, never a mixed set.
12. Startup failure before first tick records activation failure and atomically restores the prior revision.
13. A defect after first tick never hot-swaps the active level; rollback occurs only at the next legal boundary.
14. Multiple sessions can remain pinned to older complete revisions while another eligible boundary selects a newer active revision; a later defect in an older pinned superseded revision marks only that revision `rolled-back`, leaves the newer active pointer unchanged, and prevents the defective revision from becoming a rollback target.
15. Missing Designer, annotator, feedback, image generation, or network access continues on last-known-good content.
16. Garbage collection refuses to remove active, pinned, rollback, replay-referenced, or receipt-referenced bytes.
17. Rejected candidates never become rollback targets; only previously active complete revisions can be rolled back.

## Explicit non-goals of this contract

This document does not:

- implement or host the actual Designer agent;
- allow executable logic, scripts, plugins, arbitrary URLs, or remote fetches in content;
- define concrete inbox/outbox paths, file permissions, lock format, or atomic rename sequence;
- choose final byte/count/time/CPU/memory/network budgets;
- define JSON schemas, combat primitives, image normalization algorithms, or solvability algorithms;
- permit mid-level activation, hot patching, or client-selected content;
- make candidate availability a requirement for gameplay;
- mutate the accepted production baseline or authorize deployment.

## Consequences

- Content iteration can continue outside the trusted engine without making the engine dependent on an agent.
- Every level and replay has stable content provenance.
- Late creative work is safely deferred or rejected rather than racing publication.
- Rollback requires retaining complete immutable revisions and durable transaction receipts.
- Multiple concurrent sessions may use different pinned revisions, increasing retention needs but preserving simulation truth.
- Follow-on filesystem, budget, threat-model, schema, runtime, and acceptance tasks have one fail-closed lifecycle to implement.
