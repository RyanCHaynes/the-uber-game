# ADR 0006: Engine filesystem exchange protocol

- **Status:** Proposed design contract; implementation remains separately gated
- **Date:** 2026-07-18
- **TD task:** `td-ac4b.2.6`
- **Depends on:** [ADR 0001](0001-vnext-engine-and-designer-boundary.md), [ADR 0005](0005-immutable-content-lifecycle.md)
- **Related reviewed contracts:** mode semantics (`td-ac4b.2.2`), authority boundary (`td-ac4b.2.3`), deterministic replay (`td-ac4b.2.4`)
- **Review base:** `7703d19c227d4e299924ce2967ad3d0a6eaef81d`
- **Accepted compatibility baseline:** `52941476f9af110df9be0b3a0a118d4b76c38e0a`

## 1. Purpose

Coin Rush vNext needs a vendor-neutral way for an optional external producer to read bounded Engine context, offer untrusted JSON/PNG content, and consume validation, rejection, staging, activation, and rollback feedback. The Engine must not call a model API, execute producer output, trust producer locks, or observe a partially written candidate.

This contract fixes:

- the Engine/producer directory boundary and ownership model;
- canonical path and envelope identities;
- producer-to-Engine atomic publication;
- Engine claim, immutable snapshot, and lifecycle handoff;
- Engine-to-producer request bundles, receipts, and rejection reports;
- concurrency, idempotency, durability, crash recovery, and retention invariants;
- a fake-writer acceptance flow that uses files only.

The governing rule is:

> A rename can make untrusted bytes eligible for Engine inspection; only an Engine-owned, digest-verified snapshot and durable registry receipt can make them a lifecycle candidate. No filesystem entry can directly activate content.

The actual Designer agent, its prompts, model runtime, scheduler, and network access remain outside this pass.

## 2. Trust domains and roles

### 2.1 Engine

The Engine runs under a dedicated non-root service identity. It is the only writer of:

- claimed-offer storage;
- Engine-owned candidate snapshots and revision storage;
- the lifecycle registry and monotonic receipt sequence;
- request/context bundles;
- validation receipts, rejection reports, activation receipts, and rollback receipts;
- active and rollback selection records.

The Engine treats every byte and filename reachable from a producer-writable directory as hostile. It never imports, executes, shells out to, dynamically loads, or evaluates candidate content.

### 2.2 Producer

A producer is a configured local identity such as a fake fixture, human-operated tool, or future Designer. It may:

- read Engine-published request bundles and append-only feedback for its configured `producerId`;
- write only inside its own inbox staging and ready directories;
- atomically offer one complete directory;
- reference one immutable Engine request digest in a later offer.

A producer has no write permission to Engine claims, snapshots, revisions, registry, active/rollback records, or final outbox entries. Producer identity comes from the configured directory and operating-system credential, never from an untrusted manifest field alone.

### 2.3 Browser and live simulation

Browsers never read the exchange root, publish candidates, choose candidates, or consume producer receipts. An active level never reads from inbox, claims, or outbox. It uses only its already pinned immutable revision.

## 3. Filesystem and process prerequisites

The exchange root must be on one local filesystem whose regular-file, directory, `rename`, exclusive-create, and directory-`fsync` semantics have been acceptance-tested. The implementation must fail startup if required paths cross mounts or if the filesystem cannot provide the tested semantics. NFS, object-store FUSE mounts, and network shares are forbidden unless a later reviewed release proves equivalent behavior.

Normative process rules:

- Engine and producer use distinct non-root UIDs.
- Each producer has a configured ASCII `producerId` and isolated directory roots.
- Engine temporary and final directories use a restrictive umask and explicit modes.
- Producer-writable directories are mounted `nodev`, `nosuid`, and `noexec` where the platform supports it.
- The Engine opens paths relative to already-open directory descriptors. It does not re-resolve untrusted absolute paths.
- Candidate inspection uses no-follow, regular-file-only operations and rejects symbolic links, hard links, devices, sockets, FIFOs, executable bits, unexpected extended attributes, and mount crossings.
- No correctness rule depends on a producer-created lock file, filesystem event delivery, modification timestamp, inode enumeration order, or wall-clock timestamp.

## 4. Normative directory layout

`CONTENT_ROOT` is configured outside producer input. Version 1 uses exactly one exchange namespace:

```text
CONTENT_ROOT/
  exchange-v1/
    inbox/
      <producerId>/
        staging/                       # producer writes; Engine ignores
        ready/                         # producer publishes by directory rename
    claims/
      <producerId>/                    # Engine-owned claimed hostile offers
    snapshot-tmp/                      # Engine-owned incomplete copies
    store/
      candidates/
        sha256/<revisionDigest>/        # Engine-owned immutable candidate snapshot
      revisions/
        sha256/<revisionDigest>/        # complete validated/staged/active sets
    outbox-tmp/                         # Engine-owned incomplete output
    outbox/
      <producerId>/
        requests/
          request-sha256-<requestDigest>/
        events/
          <outboxSequence>-<kind>-sha256-<receiptDigest>.json
        reports/
          sha256/<reportDigest>.json
    registry/                           # Engine-owned lifecycle/receipt authority
      envelopes/
        sha256/<offerDigest>.json        # verified transport envelope, not revision bytes
    quarantine/                         # Engine-owned non-authoritative evidence
```

The Engine may use a database inside `registry/`, but the database and its transaction log are Engine-owned durable state. A symlink named `active`, a producer filename, an outbox event, or a directory's presence is never the active pointer.

### 4.1 Ownership template

Equivalent ACLs are allowed only when tests prove the same boundary. The default template is:

| Path class | Owner | Producer access | Required property |
| --- | --- | --- | --- |
| `exchange-v1/` | Engine | traverse only to assigned roots | not producer-writable |
| `inbox/<producerId>/staging` | producer, Engine-readable group | read/write/rename | isolated per producer |
| `inbox/<producerId>/ready` | producer, Engine-readable group | publish/remove own offers | remains untrusted |
| `claims`, `snapshot-tmp`, `store`, `registry`, `quarantine` | Engine | none | mode `0700` or stricter equivalent |
| `outbox-tmp` | Engine | none | mode `0700` |
| `outbox/<producerId>` final tree | Engine, producer-readable group | read/traverse only | directories no more permissive than `0750`, files `0440` |

The Engine must not run with the producer UID, and the producer must not be placed in a group that can write Engine-owned paths. Root is not used to compensate for a broken ownership layout.

## 5. Canonical identifiers and paths

### 5.1 Producer identity

A configured `producerId` matches:

```text
^[a-z][a-z0-9-]{0,31}$
```

It is bound to one OS identity. Unknown producers have no directory and no admission path.

### 5.2 Digest and sequence encoding

- SHA-256 values are exactly 64 lowercase hexadecimal characters.
- `receiptSequence` is the Engine-assigned candidate-observation order required by ADR 0005; it is lifecycle data, not a filesystem timestamp.
- `outboxSequence` is a separate Engine-assigned unsigned publication order rendered as exactly 20 zero-padded decimal digits in event filenames.
- A digest is computed over the exact bytes named by its schema. Hex text is never substituted where a hash formula requires raw digest bytes.
- Timestamps may appear as bounded diagnostics but are not identity, ordering, selection, or replay authority.

### 5.3 Relative inventory paths

Candidate inventory paths are relative to the offered directory's `files/` root and must:

- use `/` separators and printable lowercase ASCII;
- contain one or more segments matching `^[a-z0-9][a-z0-9._-]*$`;
- contain no empty, `.`, or `..` segment;
- contain no backslash, colon, control byte, NUL, leading slash, trailing slash, percent-encoded alias, Unicode confusable, or normalization alternative;
- be unique as exact bytes and under the release-pinned depth, segment, path-length, file-count, and byte budgets from `td-ac4b.2.7`.

The Engine does not case-fold or repair a path. JSON and PNG are the only candidate media families. A schema may narrow extensions further. Arbitrary URLs and remote references are forbidden.

## 6. Candidate offer envelope

A final offered directory has the exact name:

```text
offer-sha256-<offerDigest>
```

It contains exactly:

```text
candidate.json
files/
  <every and only inventory path named by candidate.json>
```

`offerDigest` is SHA-256 of the exact `candidate.json` bytes. `candidate.json` is the RFC 8785 JCS encoding of one object under the versioned candidate-envelope schema followed by exactly one LF. It binds at least:

- exchange protocol and candidate-envelope schema versions;
- configured producer identity as a claim that must match the directory credential;
- one bounded lowercase-hex idempotency key;
- bounded attempt number;
- expected base revision digest;
- target scope, request digest, and future boundary ID;
- engine/protocol/content-schema compatibility;
- ordered complete file inventory with relative path, media type, exact byte size, and SHA-256 digest;
- content-manifest path and digest;
- bounded provenance references without credentials, raw private prompts, or arbitrary URLs.

The transport `offerDigest` is distinct from the lifecycle `revisionDigest`. The Engine recomputes both according to their versioned schemas. This avoids a self-referential manifest hash and prevents a directory name from asserting revision authority.

Unknown fields, duplicate JSON keys, non-canonical JSON, unsupported versions, invalid UTF-8, and values beyond separately reviewed budgets fail closed.

## 7. Producer publication protocol

A producer publishes one candidate as follows:

1. Create a unique directory only under its own `staging/` root. Its name and contents have no protocol meaning while in staging.
2. Write `files/` and every inventory file without symlinks or special files.
3. Close every file, compute the inventory, and write `candidate.json` last.
4. Re-read and verify local sizes and digests.
5. `fsync` regular files, then each created directory from leaves to the staging root.
6. No-replace rename the complete staging directory, on the same filesystem, to the exact final path under `ready/`; an existing final name is never overwritten.
7. `fsync` both staging and ready parent directories.
8. Never write, rename, chmod, truncate, or replace anything inside that final ready offer again.

The Engine ignores every entry under `staging/`. It considers only exact final-name entries directly under `ready/`. A temporary suffix, hidden entry, nested ready entry, or invalid final name is not an offer and cannot delay gameplay. Per-producer filesystem quotas and bounded operator cleanup contain ignored bytes without recursively parsing or repeatedly logging them.

Publication is idempotent by envelope identity and idempotency key. A producer must not overwrite a final offer. A correction is a newly manifested offer with a new `offerDigest`, lifecycle digest, and attempt.

A producer crash before the final rename leaves only ignored staging bytes. A crash after rename may leave a durable final offer or no final offer; it never grants partial lifecycle authority. Failure to perform producer-side `fsync` can lose the offer after host failure, but loss only produces absence/rejection and last-known-good continuation.

## 8. Engine claim protocol

Filesystem notification is a wake-up hint only. The Engine always verifies directory state by a bounded scan.

For each configured producer, the Engine:

1. Lists direct exact final-name entries in `ready/` under a finite scan budget.
2. Sorts the observed `offerDigest` names ascending before claim attempts. The later durable receipt sequence, not filesystem order or event time, is selection authority.
3. Claims an offer with same-filesystem `renameat2(..., RENAME_NOREPLACE)` or a proven no-replace equivalent from `ready/offer-sha256-D` to `claims/<producerId>/offer-sha256-D.claim`.
4. `fsync`s both parent directories.
5. Inserts or recovers one registry claim keyed by `(producerId, offerDigest)` and assigns one monotonic `receiptSequence` in an Engine transaction.
6. Emits no lifecycle candidate until the immutable snapshot protocol succeeds.

The atomic rename is the claim lock. Exactly one Engine worker can win it. An Engine-only advisory process lock may reduce duplicate work, but registry uniqueness plus no-replace rename provides correctness.

If a producer removes an offer before the Engine wins the claim, the Engine observed no candidate. If the Engine wins, the producer loses pathname access to the claimed tree. A producer-held open file descriptor is still treated as hostile; it cannot alter the Engine snapshot after that snapshot is committed.

If the no-replace claim destination already exists, the Engine consults the unique registry claim. An exact duplicate retry returns the prior event paths and is quarantined or removed under bounded policy only after its envelope digest re-verifies; it never receives another lifecycle receipt sequence. A conflicting ready entry is retained as hostile evidence or rejected without touching the first claim.

A duplicate envelope already present in registry or claims returns the existing event paths idempotently. A repeated idempotency key with identical envelope and revision returns prior results. The same idempotency key with different bytes is terminal `attempt_conflict`.

## 9. Immutable snapshot protocol

A claimed directory remains hostile and non-authoritative. The Engine creates its own snapshot:

1. Open the claim root by directory descriptor with no-follow semantics and verify the configured filesystem device.
2. Read `candidate.json` under a strict pre-parse byte ceiling; verify exact `offerDigest`, canonical encoding, producer binding, and envelope schema.
3. Validate the complete declared inventory before copying. Reject undeclared entries, missing entries, duplicate paths, unsafe paths, unsupported types, directories not implied by inventory, special files, symlinks, hard links, executable files, mount crossings, and pre-budget violations.
4. Create an Engine-owned random/non-authoritative temporary directory only under `snapshot-tmp/` with exclusive creation and mode `0700`.
5. For each canonical inventory path in manifest order, open the claimed source relative to its directory descriptor, verify regular-file metadata, stream-copy once to an exclusively created Engine-owned destination, and compute size and digest over copied bytes.
6. Reject the complete offer if any copied bytes disagree with the inventory. Source metadata changes during copying are a rejection unless the resulting Engine-owned bytes still exactly match the declared immutable inventory.
7. Write only the content-set bytes and canonical revision metadata derived solely from those bytes; offer-, producer-, and claim-specific metadata is not stored inside a revision-addressed directory. `fsync` every file and directory, then close all descriptors.
8. Re-open and verify the Engine-owned copy and complete revision digest from the location that validation will read.
9. Atomically no-replace rename the temporary snapshot to `store/candidates/sha256/<revisionDigest>/` and `fsync` both parents.
10. Publish the verified exact `candidate.json` separately, through Engine-owned temporary-file plus no-replace rename and directory `fsync`, at `registry/envelopes/sha256/<offerDigest>.json`.
11. Persist the snapshot digest, file inventory, receipt sequence, engine version, offer-to-revision binding, and claim lineage in registry before lifecycle validation begins.

Only step 9 creates a complete lifecycle candidate byte set. Different offers that produce the same verified revision share those exact revision bytes but retain separate envelope/claim receipts. If an identical revision snapshot already exists and re-verifies, the Engine references it idempotently. If the final path exists with different bytes or content-derived metadata, the Engine stops content ingestion and reports an integrity fault; it never overwrites.

The Engine never edits or repairs a snapshot. Deterministic normalization, if required, produces a separately manifested and separately digested offer before this protocol.

## 10. Lifecycle handoff and activation boundary

`offered`, `claimed`, and `snapshotting` are transport phases, not additional ADR 0005 lifecycle states. A failure before snapshot commit produces a terminal digest-bound `rejected` decision with the identities that could be verified; it never creates mutable or partially valid candidate bytes. After snapshot commit, the registry records the complete `candidate`, and ADR 0005 owns `candidate -> validating -> validated -> staged -> active/rejected` transitions.

The file protocol adds these invariants:

- Every validation step reads only the Engine-owned snapshot, never producer inbox or claim bytes.
- Staging assembles and re-verifies one complete Engine-owned revision under `store/revisions/sha256/<revisionDigest>/` using temporary-directory plus no-replace rename semantics.
- Producer bytes and output receipts cannot mutate registry state.
- The active pointer is one durable registry transaction. A filesystem symlink or directory rename may be a derived cache only and is not authority.
- Active, pinned, immediate rollback, replay-referenced, and receipt-referenced revisions are read-only and retained.
- A candidate arriving while a level runs cannot be read by that level and cannot change its revision or asset paths.
- At cutoff, ADR 0005's attempt-descending, receipt-sequence-ascending, revision-digest-ascending key selects at most one staged revision. The receipt ledger records the complete eligible set and key.
- Any missing, malformed, late, stale, timed-out, crashed, or rejected exchange operation leaves last-known-good selection unchanged.

## 11. Engine-to-producer outbox

The Engine publishes two immutable output classes: context requests and ordered events.

### 11.1 Request bundles

A request bundle is optional and has final path:

```text
outbox/<producerId>/requests/request-sha256-<requestDigest>/
```

It contains `request.json` plus every and only file named by its inventory under `files/`. `requestDigest` is SHA-256 of the exact RFC 8785 JCS `request.json` object bytes followed by one LF; `request.json` omits its own digest. Bundle files may be bounded schema-versioned JSON/NDJSON or Engine-written copies of already validated PNG assets, never symlinks or mutable references outside the bundle. The request manifest binds:

- producer and request schema versions;
- sealed replay segment/result digest;
- active/base content revision;
- target scope and eligible future boundary;
- bounded telemetry, explicit player-feedback, and optional provenance-marked annotator-story digests;
- complete ordered inventory and byte digests;
- expiry/cutoff identity expressed as a server-owned boundary fact, not producer wall time.

Private credentials, resume capabilities, IP addresses, raw model prompts, unbounded logs, and unrelated player data are excluded.

The Engine writes a request under `outbox-tmp/`, verifies it, `fsync`s files/directories, then no-replace renames the complete directory into `requests/` and `fsync`s both parents. The producer ignores `outbox-tmp/` and reads only exact final request names. Re-publishing identical request bytes is a no-op; conflicting bytes under the same digest are an integrity fault.

A producer consumes a request by reading it. It does not mark, rename, or delete Engine output. A later candidate binds `requestDigest`, target boundary, and expected base in `candidate.json`; that immutable reference is the protocol acknowledgement.

### 11.2 Ordered event receipts

Each claimed offer receives append-only Engine event files:

```text
outbox/<producerId>/events/
  <outboxSequence>-<kind>-sha256-<receiptDigest>.json
```

Allowed `kind` values are a closed versioned set such as:

- `claimed`;
- `snapshot-rejected`;
- `validating`;
- `validated`;
- `staged`;
- `activated`;
- `rejected`;
- `rolled-back`;
- `no-activation`.

A receipt binds at least:

- receipt schema version and Engine-assigned `outboxSequence`;
- candidate `receiptSequence`, or explicit null only for an output not tied to a claimed offer;
- producer, offer, idempotency, candidate/revision, expected/observed base, request, scope, and boundary identities where known;
- Engine release, protocol, schema, validator, and art-profile versions;
- prior and resulting lifecycle states;
- ordered check identifiers and outcomes;
- stable reason code and optional rejection-report digest;
- prior and resulting active revision digests;
- lifecycle decision sequence/tick/boundary and prior event-receipt digest when one exists;
- bounded provenance reference without secrets or raw untrusted prompts.

Receipt bytes are one RFC 8785 JCS object followed by exactly one LF and omit their own `receiptDigest`. `receiptDigest` is SHA-256 of those exact final bytes and appears in the filename and later cross-references. The Engine allocates `outboxSequence` in the durable registry, creates and `fsync`s a temporary file under `outbox-tmp/`, then publishes with exclusive no-replace rename and parent-directory `fsync`.

The producer lists events by numeric `outboxSequence` and verifies filename/content digest. Sequence gaps may remain after a crash and have no semantic meaning. Existing event bytes never change. A duplicate publication of exact bytes succeeds idempotently; different bytes under an existing name stop publication as an integrity fault. Candidate selection continues to use the distinct ADR 0005 `receiptSequence`, not outbox publication order.

### 11.3 Rejection reports

A terminal rejection or rollback may reference:

```text
outbox/<producerId>/reports/sha256/<reportDigest>.json
```

The report contains a bounded ordered array of machine-readable findings. Each finding has a stable reason code, check ID, safe logical inventory path or JSON pointer when available, expected/observed bounded values or digests, and a bounded human detail. Report bytes are one RFC 8785 JCS object followed by exactly one LF and omit their own digest; `reportDigest` is SHA-256 of those exact bytes.

Reports never include host paths, stack traces, environment values, credentials, raw prompts, file contents, private feedback, or arbitrary producer-controlled text without escaping and length bounds. The report is published atomically before the event receipt that references its digest. A report cannot change lifecycle state by itself.

## 12. Idempotency and concurrency

The protocol uses three independent identities:

- `offerDigest` identifies exact envelope bytes for transport;
- `idempotencyKey` identifies one producer operation across retries;
- `revisionDigest` identifies one complete immutable lifecycle content set.

Required outcomes:

- same producer + same offer + same idempotency key: return prior claim/snapshot/lifecycle receipts;
- same producer + same idempotency key + different offer/revision bytes: terminal `attempt_conflict`;
- different offers producing the same verified revision: one immutable stored revision, separate offer receipts, and no byte overwrite;
- concurrent claim attempts: one no-replace rename winner;
- concurrent registry insert: one unique claim row and one receipt sequence;
- concurrent staged candidates: ADR 0005 selection key chooses one and rejects non-selected attempts with `activation_slot_filled`;
- repeated request or receipt publication: exact-byte no-op; conflicting-byte integrity fault.

Candidate `receiptSequence` allocation and event `outboxSequence` allocation are independently serialized by the Engine registry and may contain gaps after crashes. Gaps have no semantic meaning. Filesystem event order, producer timestamps, directory enumeration, and `outboxSequence` never become the ADR 0005 selection tie-break.

## 13. Durability and crash recovery

Atomic visibility and durable recovery both matter. Every Engine rename that establishes a claim, snapshot, request, report, or receipt is followed by `fsync` of source and destination parent directories. Every final Engine file is closed and `fsync`ed before rename.

Startup performs bounded recovery before new claims:

| Recovered state | Required action |
| --- | --- |
| Producer staging entry only | ignore; it was never published |
| Ready offer only | eligible for a normal claim |
| Claimed directory without registry claim | recover claim by digest in sorted order, assign/restore one sequence, or reject safely |
| Registry/claimed offer plus the same ready name | treat ready entry as a duplicate retry, verify/quarantine under bounded policy, return prior events, and never create a second candidate receipt sequence |
| Snapshot temporary directory | verify against its claim and resume deterministically, or delete/quarantine it; never validate it in place |
| Complete candidate snapshot without matching registry commit | reverify and reconcile only to its unique claim; otherwise quarantine as non-authoritative |
| Registry candidate without complete snapshot | retry snapshot from a retained claim or reject; never enter validation |
| Outbox temporary entry | ignore/delete after registry reconciliation |
| Durable receipt missing final outbox file | regenerate exact canonical bytes from the durable registry and republish idempotently |
| Final outbox file without matching registry receipt | quarantine and report integrity failure; never infer lifecycle state from it |
| Revision assembly temporary directory | resume/rebuild from immutable candidate or discard; active pointer remains unchanged |
| Crash before activation registry commit | old active revision remains active |
| Crash after activation registry commit | resolve to the complete committed revision or execute ADR 0005 rollback; never mix files |

Recovery never trusts modification time, repairs producer bytes, or asks a browser/Designer which revision should be active.

## 14. Resource and abuse containment

Exact numerical budgets belong to `td-ac4b.2.7`, but this protocol requires finite release-pinned ceilings for:

- producers, staging/ready entries, claim attempts, scan work, and concurrent validators;
- candidate files, paths, directory depth, JSON depth, strings, arrays, PNG dimensions/decompression, per-file bytes, and total bytes;
- request, telemetry, feedback, receipt, report, and retained-event bytes;
- CPU, wall time, memory, file descriptors, temporary storage, and retry count;
- quarantine and retention volume.

Budget exhaustion rejects or defers candidate work without changing active content or blocking a clean level transition. The Engine processes ingestion at lower priority than authoritative simulation and can disable intake while continuing last-known-good gameplay.

Malformed ready entries cannot cause unbounded recursion or logging. The Engine never follows producer links, mounts, URLs, or executable references. Diagnostic text is bounded before logging and outbox publication.

## 15. Retention and garbage collection

Garbage collection is Engine-owned and operates only from durable registry references. It must refuse to remove:

- active or immediate rollback revisions;
- any revision pinned by an active/paused session;
- snapshots/revisions referenced by replay lineage, accepted result, activation/rollback receipt, or release evidence;
- claims or candidate snapshots needed for pending validation, staging, rejection reporting, or crash recovery;
- outbox events not past the reviewed producer-retention policy.

Producer deletion of staging/ready bytes cannot delete Engine snapshots or receipts. Outbox deletion by a privileged operator does not reverse lifecycle state; missing retained evidence is an operational integrity failure.

## 16. Fake-writer reference flow

A deterministic fake producer proves the interface without a model vendor:

```text
Engine seals level result on revision A
  -> Engine atomically publishes request R in producer outbox
  -> fake writer reads and verifies R
  -> fake writer creates complete candidate B only in inbox staging
  -> fake writer atomically renames offer(B) into ready
  -> Engine atomically claims offer(B)
  -> Engine copies and verifies immutable snapshot B
  -> Engine publishes claimed/validation receipts
  -> Engine validates and stages B or publishes a rejection report
  -> fake writer reads and verifies receipts/reports using files only
  -> at an eligible boundary, Engine activates B or records no-activation
```

No socket, RPC callback, model API, shared memory, or live gameplay command is required. The fake writer must be replaceable by any process that obeys the same filesystem bytes and permissions.

## 17. Required acceptance matrix

Implementation cannot close this contract from documentation alone. Automated and independent evidence must prove at least:

1. A valid fake writer reads one Engine request, publishes one complete offer using files only, and consumes claimed, validated/staged, and activation feedback using files only.
2. A fake writer publishes a deliberately invalid offer and consumes one bounded digest-bound rejection report and terminal receipt.
3. Files left in producer staging for an arbitrarily long interval are never scanned, claimed, parsed, copied, or counted as lifecycle candidates.
4. A producer writing slowly, crashing mid-file, or crashing before final rename produces no observed candidate.
5. Final directory rename makes one namespace visible atomically; the Engine claim rename has exactly one winner under concurrent workers.
6. Mutation, truncation, replacement, chmod, or open-file writes after publication cannot mutate the Engine snapshot; mismatch rejects the complete offer.
7. Symlinks, hard links, path traversal, absolute paths, case/encoding aliases, mount crossings, devices, sockets, FIFOs, executable files, unexpected entries, duplicate paths, and unsupported media fail closed.
8. Envelope, inventory, file, content-manifest, revision, report, receipt, and request digests are independently recomputed and exact.
9. Same-offer retries return prior receipts; same idempotency key with different bytes rejects `attempt_conflict`; no final path is overwritten.
10. Two concurrent valid offers receive unique durable receipt sequences. ADR 0005's recorded selection key chooses exactly one and replay chooses the same digest.
11. Producer permissions cannot write claims, snapshots, revisions, registry, active/rollback records, or final outbox bytes. Browser/runtime identities cannot write inbox.
12. Request, report, and receipt publication is invisible until final rename. A producer never observes a partial final output.
13. Crash at every claim/snapshot/outbox/staging/activation boundary recovers to the documented state without duplicate effects, mixed revisions, or active-pointer loss.
14. Crash before snapshot commit never starts validation. Crash after snapshot commit reuses the exact Engine-owned bytes.
15. Crash before activation commit keeps the old active revision. Crash after commit resolves to one complete revision and preserves rollback.
16. Malformed, stale, late, wrong-boundary, wrong-base, unsupported, over-budget, validator-timeout, and dry-run-failed candidates leave last-known-good bytes and pointer unchanged.
17. An active level remains pinned and byte-identical while candidates arrive, validate, stage, reject, activate for another session, or are garbage-collected.
18. Intake saturation, watcher loss, producer absence, producer crash, missing request consumption, and outbox backpressure do not prevent level start, play, completion, or last-known-good continuation.
19. Garbage collection refuses every active, pinned, rollback, replay-, receipt-, release-, and recovery-referenced object.
20. Receipts and reports reveal no secret, host path, stack trace, raw prompt, private feedback, or unbounded producer text.

## 18. Explicit non-goals

This contract does not:

- ship or host the actual Designer agent, annotator, image model, prompt set, scheduler, or network client;
- define final numeric budgets (`td-ac4b.2.7`), threat controls (`td-ac4b.2.8`), content schemas, or validation algorithms;
- allow executable content, scripts, plugins, dynamic imports, shell commands, arbitrary URLs, or remote asset fetching;
- use producer lock files, timestamps, event order, or mutable acknowledgements as authority;
- permit direct producer-to-browser publication, producer-to-live-room commands, mid-level activation, or hot swapping;
- make candidate/request/feedback availability necessary for gameplay;
- authorize deployment or mutation of a live release.

## 19. Consequences

- The Engine can be tested end-to-end with a deterministic fake writer before any agent integration exists.
- Producers can be replaced without changing the trusted runtime or lifecycle semantics.
- Directory rename gives atomic visibility, while Engine-owned copy-and-verify prevents producer ownership and open handles from making accepted bytes mutable.
- Append-only digest-bound output gives producers actionable feedback without granting them registry authority.
- Crash safety requires explicit directory `fsync`, registry reconciliation, immutable storage, and more acceptance fixtures.
- Content latency or failure remains isolated from active play; last-known-good continuation is always the fallback.
