# ADR 0001: Coin Rush vNext engine and Designer boundary

- **Status:** Accepted design direction; implementation remains gated on baseline freeze
- **Date:** 2026-07-18
- **TD task:** `td-ac4b.2.1`
- **Baseline:** `52941476f9af110df9be0b3a0a118d4b76c38e0a`

## Context

The accepted browser baseline is an authoritative two-to-ten-player castle coin race. Coin Rush vNext turns that foundation into a side-scrolling action platformer with fully playable single-player PvE while preserving multiplayer support.

The game must be able to consume newly proposed enemies, levels, and pose art between levels without making an agent, model vendor, or image-generation service part of the trusted game engine. Generated or externally supplied content is untrusted data.

This ADR fixes the product and trust boundaries. Detailed mode semantics, protocol ownership, deterministic replay, content lifecycle, filesystem protocol, budgets, and threat controls are separate follow-on contracts in `td-ac4b.2.2` through `td-ac4b.2.8`.

## Decision

### 1. Product shape

Coin Rush vNext is an authoritative side-scrolling action platformer with:

- immediate, complete one-player PvE play that does not require a second player or a bot;
- retained two-to-ten-player modes under explicit, deterministic mode rules;
- traversal, combat, enemies, health/damage, level completion, progression, and a monster manual;
- original gothic-medieval pixel art inspired by the mood and readability of classic castle action games, without copying protected characters, sprites, layouts, logos, or other assets;
- explicit end-of-level player feedback and authoritative gameplay telemetry.

### 2. The engine is authoritative and agent-agnostic

The Node game service remains the sole authority for accepted inputs, simulation time, movement, collision, enemy behavior, hit tests, damage, spawning, progression, scoring, wins, resets, disconnects, and content activation.

The browser submits bounded intent and renders authoritative state. It does not decide gameplay outcomes or publish content.

The engine does not call an LLM, image model, or Designer API. It does not need to know whether a candidate was written by an agent, a human, or a deterministic fixture.

### 3. Determinism is a release requirement

Simulation uses a fixed-step, ordered, seedable model. Content revision, seed, ordered inputs, and engine version must be sufficient to reproduce authoritative state and event digests. Rendering interpolation and visual effects may be cosmetic, but they cannot affect simulation results.

The exact clock, ordering, randomness, snapshot, and replay contract is defined by `td-ac4b.2.4`.

### 4. Content is bounded data, never executable logic

Enemies, attacks, levels, pose metadata, and related content are schema-versioned JSON plus validated PNG assets. Behavior is expressed only through allowlisted runtime primitives with finite fields, counts, ranges, and byte sizes.

Candidates may not contain scripts, bytecode, `eval` input, dynamic imports, shell commands, arbitrary filesystem paths, arbitrary URLs, or plugin code. Content cannot expand the engine's primitive set.

All untrusted files require safe-path checks, digests, schema validation, semantic validation, budget enforcement, and a dry run before they are eligible for activation.

### 5. Content changes only between levels

An active level pins one immutable content revision for its entire run. A candidate can be received or staged while a level is active, but it cannot mutate that level.

Activation is atomic at a between-level boundary. Malformed, stale, late, oversized, unsafe, or failed candidates are rejected without changing the last-known-good revision. Activation failures roll back to the previous complete revision.

The detailed lifecycle and file protocol are defined by `td-ac4b.2.5` and `td-ac4b.2.6`.

### 6. The Designer is external and outside this pass

This pass ships the engine-side Designer interface:

- bounded telemetry and feedback output;
- an optional, provenance-marked annotator story format;
- immutable context bundles;
- candidate inbox, receipts, rejection reports, validation, dry runs, activation, and rollback;
- deterministic fake-producer fixtures for end-to-end acceptance.

This pass does **not** ship the actual Designer agent, its model prompts, its model runtime, or a hosted Designer service. Those are a separate pass against the same file contract.

Designer and annotator availability is optional. A level must start, play, finish, and transition using last-known-good content when either is absent, slow, or failing.

### 7. Art uses five key poses and runtime motion

Each generated enemy pack targets five semantic poses: `idle`, `move`, `attack`, `hit`, and `death`. Assets are normalized into native-scale pixel art with a coherent palette, silhouette, facing direction, anchors, padding, transparency, lighting, and collision-independent presentation metadata.

Runtime tweening, timing, recoil, squash/stretch, flashes, particles, trails, camera response, and other cosmetic effects create motion and impact. Cosmetic animation cannot alter authoritative hit timing or collision geometry.

Batman owns the bounded Codex CLI image-generation, normalization, validation, and immutable pose-pack pipeline. Placeholder packs unblock engine work so live image-generation latency is never a runtime dependency.

## What ships in the vNext engine pass

- One-player PvE and explicit two-to-ten-player coexistence.
- Deterministic authoritative traversal, combat, enemies, level progression, scoring, and lifecycle behavior.
- Validated, versioned enemy, attack, level, and pose-pack schemas backed by allowlisted runtime primitives.
- Browser rendering, input, combat feedback, HUD, feedback capture, and monster manual.
- Original native-scale gothic-medieval pixel-art placeholder and generated pose packs.
- Authoritative telemetry, explicit player feedback, and optional validated annotator-story ingestion.
- Engine-only file inbox/outbox, fake Designer producer, validation, dry run, atomic activation, rejection receipts, and rollback.
- Replay, fuzz, browser, load, security, failure-mode, and immutable-release acceptance.

## Explicit non-goals

The following do not ship in this pass:

- the actual Designer agent, model, prompts, hosted service, or autonomous scheduler;
- full sprite-sheet generation between levels;
- generated executable behavior, plugins, scripts, or arbitrary code;
- mid-level content mutation or publication directly by the Designer;
- making image generation, annotation, or any external service necessary to play or finish a level;
- client-authoritative physics, AI, combat, scoring, progression, or content publication;
- unbounded procedural content, arbitrary remote asset fetching, or arbitrary URLs;
- copied Castlevania artwork, characters, sprites, maps, branding, or audio;
- photoreal or painterly final game assets in place of the specified pixel-art presentation;
- replacing deterministic rules with model inference inside the simulation loop;
- sponsor-track claims without a real qualifying implementation and evidence;
- removing the accepted production rollback path before its required acceptance gates pass.

## Consequences

- Engine and client development can use hand-approved placeholder data without waiting for image generation or a Designer.
- External creativity is replaceable and failure-isolated; the trusted runtime stays small and testable.
- New content is limited to capabilities the engine already understands. Adding a new primitive requires a reviewed engine release, not a content-file change.
- Generated assets may take time, but generation cannot stall active gameplay.
- More validation and receipt machinery is required before adaptive content can activate.
- Production remains pinned to the accepted baseline until the complete dependency chain and independent acceptance permit an immutable replacement release.

## Acceptance mapping

This ADR records:

- side-scrolling action-platformer scope;
- fully playable single-player plus retained multiplayer;
- original gothic-medieval pixel-art direction;
- deterministic server authority and client trust boundary;
- external, optional Designer separation;
- bounded JSON/PNG data with no executable agent output;
- five-pose animation strategy;
- between-level atomic activation and last-known-good fallback;
- engine-pass inclusions and explicit non-goals.
