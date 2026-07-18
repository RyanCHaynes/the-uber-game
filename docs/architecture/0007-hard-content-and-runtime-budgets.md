# ADR 0007: Hard content and runtime budgets

- **Status:** Proposed design contract; implementation remains separately gated
- **Date:** 2026-07-18
- **TD task:** `td-ac4b.2.7`
- **Depends on:** [ADR 0001](0001-vnext-engine-and-designer-boundary.md), [ADR 0005](0005-immutable-content-lifecycle.md)
- **Related contract:** engine-only filesystem exchange (`td-ac4b.2.6`)
- **Review base:** `7703d19c227d4e299924ce2967ad3d0a6eaef81d`
- **Accepted compatibility baseline:** `52941476f9af110df9be0b3a0a118d4b76c38e0a`
- **Budget profile ID:** `coinrush-vnext-budgets-v1`

## 1. Purpose

Coin Rush vNext accepts untrusted, data-authored levels, enemies, attacks, projectiles, pose metadata, PNG assets, telemetry references, feedback, and optional annotator stories. Every producer-controlled value must have a finite representation, range, count, byte size, execution cost, and stable rejection outcome before the Engine can validate or activate it.

This profile sets those release-pinned limits. Future JSON schemas may be narrower, but they may not be wider. A schema field that is not mapped to this profile or to a later independently reviewed finite profile is unsupported and rejects as `unknown_field` or `budget_unmapped_field`.

The governing rule is:

> No producer value is clamped, truncated, coerced, sampled into acceptance, or allowed to consume work without a finite preflight and runtime bound. One exceeded local or aggregate limit rejects the complete candidate; last-known-good play continues.

The values below are v1 safety limits, not design targets. Ordinary authored levels should remain well below them. They apply only to vNext candidate schemas that declare this profile. They do not retroactively reinterpret or invalidate the frozen browser/SFML baselines or an already retained rollback revision; migration into vNext produces a separately digested candidate that must pass this profile.

## 2. Enforcement model

### 2.1 Validation order

The Engine applies budgets in this order:

1. bounded stream/open and compressed-file preflight;
2. path, file-count, and exact encoded-byte limits;
3. JSON token/depth/node limits before object materialization;
4. schema types, closed keys, scalar ranges, and local collection counts;
5. cross-file references and complete-revision aggregate counts;
6. PNG chunk, dimension, palette, alpha, and decoded-byte limits before full decode;
7. derived geometry, entity, collision, behavior, and network bounds;
8. deterministic solvability/dry-run operation limits;
9. staging reread of every encoded and derived budget from immutable Engine-owned bytes.

A failure in any phase prevents later lifecycle progress. The validator may stop after 64 ordered findings and set `findingsTruncated: true`; that diagnostic cap never converts rejection to acceptance.

### 2.2 No repair or implicit defaults

- Unknown object keys reject as `unknown_field`.
- Missing required fields reject as `schema_invalid`.
- Duplicate JSON keys, invalid UTF-8, non-canonical JSON where canonical bytes are required, non-finite numbers, fractional authoritative values, and negative zero reject as `budget_scalar_domain` or the narrower code below.
- `null` is forbidden unless a schema field explicitly lists it as one of a finite closed alternatives.
- Numeric strings are not numbers. Booleans are not integers. Extra array entries are not ignored.
- The Engine does not resize art, shorten text, remove entities, merge attacks, simplify paths, reduce waves, or alter timing to make a candidate fit.
- Local limits and aggregate limits both apply. Splitting one oversized object across files does not evade a revision or level aggregate.

### 2.3 Deterministic findings

Findings are ordered by validation phase, stable reason code, canonical logical path/JSON pointer, then referenced digest. The receipt records the profile ID and exact observed/allowed values. Host paths, raw private feedback, stack traces, and producer-controlled unbounded text are excluded.

## 3. Common scalar domains

These domains apply to every producer-controlled schema unless a narrower table row overrides them.

| Domain | v1 limit | Stable rejection code |
| --- | --- | --- |
| Object keys | Closed schema; at most 128 keys per object | `budget_object_keys` |
| JSON nesting | At most 12 object/array levels | `budget_json_depth` |
| Parsed nodes | At most 100,000 scalar/object/array nodes per candidate | `budget_json_nodes` |
| Generic array | At most 16,384 entries and no sparse representation | `budget_array_count` |
| Authoritative number | JSON integer only, exact safe range `-2,147,483,648..2,147,483,647` | `budget_scalar_domain` |
| Count/index | Integer `0..1,000,000`; every field also has a narrower count below | `budget_count_range` |
| Tick duration | Integer `0..45,000` at fixed 50 Hz; zero only where explicitly allowed | `budget_tick_range` |
| Probability | Integer basis points `0..10,000` | `budget_probability_range` |
| Identifier | Lowercase ASCII `^[a-z][a-z0-9._-]{0,63}$` | `budget_identifier` |
| Digest | Exactly 64 lowercase hexadecimal characters | `budget_digest` |
| Display label | NFC UTF-8, 1–48 code points and at most 192 bytes; no controls or bidi overrides | `budget_label_bytes` |
| Description | NFC UTF-8, 0–256 code points and at most 1,024 bytes; no controls except LF | `budget_description_bytes` |
| Generic producer string | At most 2,048 UTF-8 bytes; narrower schema field still required | `budget_string_bytes` |
| Tag list | At most 16 unique identifiers | `budget_tag_count` |
| Enum | One exact member of a release-pinned closed set | `budget_enum_domain` |
| World coordinate | Integer pixels `-256..8,448` before fixed-point conversion | `budget_coordinate_range` |
| Positive dimension | Integer pixels `1..512`, narrowed by geometry/asset class | `budget_dimension_range` |
| Color | Palette index integer `0..31`; arbitrary CSS/color strings forbidden | `budget_color_domain` |

Authoritative simulation content does not carry arbitrary floating-point values. The Engine converts validated integer pixels, ticks, basis points, and fixed enumerations to its release-pinned deterministic representation.

## 4. Exchange and candidate budgets

These limits apply before content semantics. They are compatible with the atomic inbox/outbox contract but do not grant filesystem authority.

| Resource | v1 limit | Stable rejection code |
| --- | --- | --- |
| Configured producers | 4 per Engine scope | `budget_producer_count` |
| Per-producer inbox allocation | Hard filesystem/project quota of 192 MiB allocated blocks across `staging/` + `ready/` | `budget_inbox_allocated_bytes` |
| Per-producer inbox inodes | Hard quota of 6,144 including the two fixed phase roots; at most 6,142 untrusted descendants | `budget_inbox_inodes` |
| Staging subtree | At most the shared 6,142 descendants and 192 MiB hard allocation; Engine performs no recursive staging walk | `budget_staging_quota` |
| Physical ready entries | At most 64 direct children; observing a 65th disables that producer's intake before stat/open/claim | `budget_ready_physical_entries` |
| Eligible ready offers | At most 64 exact final-name directories after the physical-entry gate | `budget_ready_count` |
| One prepublication file | `st_size` at most 32 MiB before read; a larger/sparse file is rejected without reading its body | `budget_prepublication_file_bytes` |
| Ready names read per scan | At most 65 direct names and 17 KiB aggregate name bytes | `budget_scan_entries` |
| Metadata operations per scan | At most 64 no-follow `fstatat` calls | `budget_scan_metadata_ops` |
| Offer opens per scan | At most 16 directory/file opens | `budget_scan_open_ops` |
| Bytes read per scan | At most 4 MiB before yielding | `budget_scan_read_bytes` |
| Claim attempts per scan | At most 8 no-replace renames | `budget_scan_claim_ops` |
| Ingestion syscalls per scan | At most 512 metered filesystem operations | `budget_scan_syscalls` |
| Ingestion file descriptors | At most 32 per producer and 128 across Engine intake | `budget_ingestion_fds` |
| Scan cadence | At most 5 passes/second/producer and 20 passes/second/Engine | `budget_scan_rate` |
| Candidate attempts | 4 per producer per target boundary | `budget_attempt_count` |
| Pending claimed candidates | 32 per Engine scope | `budget_claim_count` |
| Concurrent validators | 2; excess valid claims queue without delaying gameplay | `budget_validator_concurrency` |
| Validation queue | 32 claims; the 33rd claimed offer terminally rejects before content validation | `budget_validation_queue` |
| Inventory files | 1–1,024 regular files per candidate | `budget_file_count` |
| Relative path | At most 8 segments, 64 ASCII bytes/segment, 256 ASCII bytes total | `budget_path_length` |
| One manifest/envelope | 256 KiB encoded | `budget_manifest_bytes` |
| One JSON/NDJSON file | 256 KiB encoded | `budget_json_file_bytes` |
| All JSON/NDJSON | 4 MiB encoded per candidate | `budget_json_total_bytes` |
| One PNG file | 512 KiB encoded | `budget_png_file_bytes` |
| All PNG files | 28 MiB encoded per candidate | `budget_png_total_bytes` |
| Entire candidate | 32 MiB exact encoded bytes, including manifests | `budget_candidate_bytes` |
| PNG decoded bytes | 64 MiB RGBA aggregate per candidate | `budget_png_decoded_bytes` |
| Request bundle | 4 MiB encoded and at most 256 files | `budget_request_bytes` |
| One event receipt | 64 KiB encoded | `budget_receipt_bytes` |
| One rejection report | 256 KiB encoded and at most 64 findings | `budget_report_bytes` |
| One provenance block | 4 KiB encoded, at most 16 references | `budget_provenance_bytes` |

Before a producer UID is enabled, its complete `staging/` + `ready/` inbox must live on a dedicated fixed-capacity local filesystem or a tested hard project quota that enforces the 192 MiB block and 6,144-inode limits in the kernel. An O(1) quota API, not `find`, `du`, recursive enumeration, or watcher history, proves the caps at install/startup and before each pass. Unsupported, inactive, or ambiguous quota enforcement disables intake with `budget_inbox_quota_unavailable` while gameplay continues.

The Engine never recursively enumerates staging. It reads at most 65 direct ready names. If name 65 exists, it emits `budget_ready_physical_entries`, stops without sorting, stating, opening, or claiming any offer from that overfull directory, and keeps the producer disabled until a bounded quota/status probe shows operator cleanup. With 64 or fewer names, it sorts those names and applies the remaining per-pass metadata/open/read/claim/syscall budgets. Oversized logical/sparse files fail from no-follow metadata before body read; the hard allocated-block and inode quotas contain physical abuse independently.

The Engine intake worker has an OS `RLIMIT_NOFILE` no greater than 256 plus per-producer/global semaphores enforcing the tighter 32/128 ingestion caps. Reaching a scan, descriptor, quota, or cadence cap yields or disables that producer with the exact code; it never spins, recursively cleans producer bytes, borrows gameplay descriptors, delays the 12-second next-level pin, or evicts active, pinned, rollback, replay-, receipt-, or release-referenced bytes. Separate Engine storage must still reserve at least two maximum candidates plus one complete active and rollback revision; lack of that reserve disables intake with `budget_storage_reserve`.

## 5. Complete revision budgets

One immutable revision may contain at most:

| Content family | v1 limit | Stable rejection code |
| --- | --- | --- |
| Levels | 32 | `budget_level_count` |
| Tile definitions | 64 | `budget_tile_definition_count` |
| Enemy definitions / monster-manual entries | 64 | `budget_enemy_definition_count` |
| Attack definitions | 128 | `budget_attack_definition_count` |
| Projectile definitions | 64 | `budget_projectile_definition_count` |
| Pose packs | 64, each bound one-to-one to an enemy definition | `budget_pose_pack_count` |
| Backdrop definitions | 32 | `budget_backdrop_count` |
| Objective definitions | 64 | `budget_objective_definition_count` |
| Total cross-file references | 8,192, all resolved exactly once | `budget_reference_count` |
| Complete revision encoded bytes | 32 MiB, same bytes admitted by the candidate envelope | `budget_revision_bytes` |
| Complete revision decoded resident data | 128 MiB in the server process | `budget_revision_memory` |

A revision is complete-set data. Referencing another mutable revision, remote resource, arbitrary URL, host path, or producer directory rejects as `reference_external` before any byte or runtime budget can be claimed.

## 6. PNG and pose-art budgets

PNG is the only accepted image format. Animated PNG, interlacing, embedded profiles over 4 KiB, unknown critical chunks, trailing bytes, and ancillary text chunks are forbidden. A decoder must enforce encoded, chunk, pixel, and decoded-byte limits before allocation.

| Asset field/class | v1 limit | Stable rejection code |
| --- | --- | --- |
| PNG dimensions, universal | At most `512×512`; width × height at most 262,144 pixels | `budget_png_dimensions` |
| PNG bit depth/type | 8-bit RGBA only after deterministic normalization | `budget_png_format` |
| PNG chunks | At most 64 chunks; one IDAT stream totaling within encoded limit | `budget_png_chunks` |
| Palette | 1–32 distinct non-transparent RGB colors per declared art pack; transparent-only assets forbidden; alpha may be 0 or 255 only | `budget_palette_entries` |
| Enemy pose image | Exactly `64×64` RGBA, at most 64 KiB encoded | `budget_pose_dimensions` |
| Poses per enemy | Exactly five unique semantic poses: `idle`, `move`, `attack`, `hit`, `death` | `budget_pose_count` |
| Pose anchors | Integer x/y each `-64..64`; one anchor record per pose | `budget_pose_anchor` |
| Pose display duration | Integer `1..300` ticks; cosmetic only | `budget_pose_duration` |
| Pose hit-flash/recoil cues | At most 8 bounded cue records per pose | `budget_pose_cue_count` |
| Tile image | Exactly `32×32` RGBA, at most 16 KiB encoded | `budget_tile_dimensions` |
| Backdrop segment | At most `512×256` RGBA, at most 512 KiB encoded | `budget_backdrop_dimensions` |
| Backdrop segments | At most 8 referenced by one level | `budget_level_backdrops` |
| UI/monster-manual icon | Exactly `32×32` RGBA, at most 16 KiB encoded | `budget_icon_dimensions` |

Pose metadata cannot contain collision geometry, hit timing, damage, AI decisions, or authoritative movement. Attempts to smuggle authority into cosmetic metadata reject as `semantic_authority_violation`, regardless of size.

## 7. Level and geometry budgets

`coinrush-vnext-budgets-v1` validates complete bounded levels. Endless streaming is not part of this profile. A future streaming design must package independently validated segments that meet the same or stricter limits and preserve authored acts/beats, fallback content, and Engine-only activation.

| Level field/resource | v1 limit | Stable rejection code |
| --- | --- | --- |
| Tile size | Exactly 32 pixels | `budget_tile_size` |
| Width | Integer 16–256 tiles | `budget_level_width` |
| Height | Integer 8–64 tiles | `budget_level_height` |
| World dimensions | At most `8,192×2,048` pixels | `budget_world_dimensions` |
| Tile layers | 1–4 closed semantic layers | `budget_tile_layer_count` |
| Tile cells | Width × height × layers, at most 65,536 cells | `budget_tile_cell_count` |
| Tile value | Integer `0..255`, and must reference one of at most 64 definitions | `budget_tile_value` |
| Derived solid rectangles | At most 2,048 after deterministic merge | `budget_collider_count` |
| One polygon/chain | Forbidden in v1; tile/rectangle geometry only | `geometry_unsupported` |
| Player spawn slots | Exactly 10 unique safe slots; solo uses slot 0 | `budget_player_spawn_count` |
| Exit markers | 1–4 | `budget_exit_count` |
| Checkpoints | 0–16 | `budget_checkpoint_count` |
| Enemy spawn markers | 0–256 | `budget_enemy_spawn_count` |
| Pickup/token markers | 0–256 | `budget_pickup_count` |
| Hazard markers | 0–256 | `budget_hazard_count` |
| Trigger volumes | 0–256 bounded tile rectangles | `budget_trigger_count` |
| All non-tile markers | At most 1,024 | `budget_marker_count` |
| Objectives | 1–8 ordered objective records | `budget_level_objective_count` |
| Waves/beats | 0–32; each has 1–16 spawn entries | `budget_wave_count` |
| Total enemy spawn requests | At most 512 over one level | `budget_level_enemy_total` |
| Simultaneous enemies requested | At most 64 | `budget_live_enemy_count` |
| Patrol paths | At most 64 | `budget_patrol_path_count` |
| Waypoints | At most 32 per path and 1,024 per level | `budget_waypoint_count` |
| Level time limit | `1,500..45,000` ticks (30 seconds–15 minutes) | `budget_level_duration` |
| Objective-stage timeout | `1..15,000` ticks and never beyond level limit | `budget_objective_timeout` |
| Solvability search | At most 200,000 nodes and 800,000 edges | `budget_solvability_ops` |
| Deterministic dry run | At most 2,000 simulated ticks and 2,000,000 metered operations | `budget_dry_run_ops` |

Spawn, exit, trigger, patrol, and objective coordinates must be integer in-bounds tile coordinates. Derived bodies must remain inside the world plus a 256-pixel kill margin. Overlap, unreachable required objectives, missing safe ground, or geometry that is within counts but semantically invalid rejects under `semantic_level_invalid`, not a warning.

## 8. Enemy and behavior budgets

Behavior is a closed state-machine description over Engine-owned primitives. No expression language, script, recursion, user-defined function, dynamic import, or unbounded loop exists.

| Enemy/behavior field | v1 limit | Stable rejection code |
| --- | --- | --- |
| Enemy types referenced by one level | 1–16 | `budget_level_enemy_types` |
| Enemy health | Integer `1..10,000` | `budget_enemy_health` |
| Contact damage | Integer `0..1,000` | `budget_contact_damage` |
| Move speed | Integer `0..512` pixels/second | `budget_enemy_speed` |
| Acceleration/gravity | Integer `0..4,096` pixels/second² | `budget_enemy_acceleration` |
| Jump/max-fall speed | Integer `0..2,048` pixels/second | `budget_enemy_vertical_speed` |
| Body width/height | Integer `8..128` pixels | `budget_enemy_body` |
| Body offset | Integer x/y each `-128..128` pixels | `budget_enemy_body_offset` |
| Detection radius | Integer `0..1,024` pixels | `budget_detection_radius` |
| Leash/patrol radius | Integer `0..2,048` pixels and within level | `budget_leash_radius` |
| Behavior states | 1–8 per enemy; state names are unique identifiers | `budget_behavior_state_count` |
| State transitions | 0–24 per enemy | `budget_behavior_transition_count` |
| Conditions | 1–4 allowlisted conditions per transition | `budget_behavior_condition_count` |
| Actions | 0–4 allowlisted actions on enter/tick/exit for one state | `budget_behavior_action_count` |
| Primitive parameters | At most 8 closed, primitive-specific scalar/reference fields per condition or action; every field maps to this profile | `budget_primitive_parameter_count` |
| Primitive reference list | At most 8 unique local IDs and no dynamic lookup/string expression | `budget_primitive_reference_count` |
| State timer | Integer `0..3,000` ticks; zero only for explicitly untimed states | `budget_state_timer` |
| Random choices | 0–8 weighted branches, each integer basis points, exact total 10,000 | `budget_random_branch_count` |
| Target queries | At most 4 declared queries per state | `budget_target_query_count` |
| Path replanning interval | Integer `10..500` ticks | `budget_path_interval` |
| One path plan | At most 256 node expansions | `budget_path_plan_ops` |
| Aggregate path work | At most 2,048 node expansions per simulation tick | `budget_path_tick_ops` |

State transitions are evaluated in schema order with one transition per enemy per tick. Any content graph with unreachable mandatory states, no finite exit from a required phase, unsupported primitive, reference cycle outside the fixed state-machine step, or aggregate operation overflow rejects as `semantic_behavior_invalid` or `budget_simulation_ops`.

## 9. Attack and projectile budgets

| Attack/projectile field | v1 limit | Stable rejection code |
| --- | --- | --- |
| Attacks referenced by one enemy | 0–8 | `budget_enemy_attack_count` |
| Hitboxes per attack | 0–4 bounded rectangles; zero requires at least one projectile | `budget_attack_hitbox_count` |
| Attack damage | Integer `1..2,000` | `budget_attack_damage` |
| Windup | Integer `0..300` ticks | `budget_attack_windup` |
| Active window | Integer `1..100` ticks | `budget_attack_active` |
| Recovery | Integer `0..300` ticks | `budget_attack_recovery` |
| Cooldown | Integer `1..3,000` ticks | `budget_attack_cooldown` |
| Invulnerability grant | Integer `0..300` ticks | `budget_invulnerability_ticks` |
| Hitbox width/height | Integer `1..256` pixels | `budget_hitbox_dimensions` |
| Hitbox offset | Integer x/y each `-256..256` pixels | `budget_hitbox_offset` |
| Knockback | Integer x/y each `-2,048..2,048` pixels/second | `budget_knockback` |
| Targets hit by one activation | At most 64; one target once unless primitive explicitly says otherwise | `budget_attack_targets` |
| Projectiles emitted by one activation | 0–8 | `budget_attack_projectiles` |
| Live projectiles per room | At most 256 | `budget_live_projectiles` |
| Projectile spawns per level | At most 2,048 | `budget_level_projectiles` |
| Projectile spawns per tick | At most 64 | `budget_tick_projectiles` |
| Projectile lifetime | Integer `1..1,000` ticks | `budget_projectile_lifetime` |
| Projectile speed | Integer `0..2,048` pixels/second | `budget_projectile_speed` |
| Projectile acceleration | Integer `-4,096..4,096` pixels/second² per axis | `budget_projectile_acceleration` |
| Projectile body | Rectangle dimensions `1..64` pixels | `budget_projectile_body` |
| Pierce count | Integer `0..8` | `budget_projectile_pierce` |
| Bounce count | Integer `0..4` | `budget_projectile_bounce` |

Damage, hit eligibility, projectile lifetime, cooldown, and invulnerability are authoritative integer tick values. Art frames and client callbacks cannot modify them.

## 10. Authoritative room and per-tick budgets

These are hard caps for one room. Content that can derive a larger worst case rejects before staging. Runtime reaching a cap due to an Engine defect records a deterministic fatal-room result and leaves other rooms/revisions intact; it does not silently drop authoritative events.

| Runtime resource | v1 limit | Stable rejection/runtime code |
| --- | --- | --- |
| Players | 1–10, deterministic slots | `budget_player_count` |
| Fixed simulation rate | Exactly 50 ticks/second | `engine_tick_rate_mismatch` |
| Snapshot rate | 1–20/second; release default 20 | `budget_snapshot_rate` |
| Live enemies | 64 | `runtime_enemy_cap` |
| Live projectiles | 256 | `runtime_projectile_cap` |
| Live authoritative pickups | 256 | `runtime_pickup_cap` |
| Total dynamic entities | 640 | `runtime_entity_cap` |
| Spawn/despawn operations | 128 per tick | `budget_spawn_tick_ops` |
| State transitions | 256 per tick | `budget_transition_tick_ops` |
| Broad-phase collision pairs | 4,096 per tick | `budget_collision_pairs` |
| Narrow-phase contacts | 2,048 per tick | `budget_collision_contacts` |
| Damage/heal events | 512 per tick | `budget_damage_events` |
| Target/raycast queries | 512 per tick | `budget_query_ops` |
| Total metered simulation operations | 20,000 per tick | `budget_simulation_ops` |
| Catch-up work | At most 5 ticks per host turn; excess becomes recorded overload, never variable-delta simulation | `runtime_tick_overload` |
| One room mutable memory | 64 MiB above shared immutable revision data | `budget_room_memory` |
| Engine process memory | 512 MiB RSS release limit; intake disables before reserve is lost | `runtime_process_memory` |
| Browser decoded content | 96 MiB per pinned revision | `budget_client_memory` |
| Browser render objects | 1,024 content-derived objects | `budget_render_object_count` |

Deterministic operation counters, not host speed, decide candidate admission. Release acceptance additionally requires a 10,000-tick worst-case fixture on the pinned production class to hold tick execution p95 ≤ 8 ms, p99 ≤ 12 ms, and maximum < 20 ms with no skipped simulation tick. A wall-time SLO failure blocks the release; it does not create different gameplay outcomes on different machines.

## 11. Network and protocol budgets

The browser submits intent only. Per-message decompression is disabled for authoritative WebSockets unless a later reviewed release proves bounded decompression.

| Network resource | v1 limit | Stable rejection/runtime code |
| --- | --- | --- |
| One client message | 2,048 UTF-8 bytes before parse | `budget_client_message_bytes` |
| Client JSON depth/nodes | Depth 4, at most 64 nodes | `budget_client_message_shape` |
| Client messages | Token bucket 60/second, burst 90 per connection | `budget_client_message_rate` |
| Input sequence | Unsigned integer `0..4,294,967,295`, monotonic under replay rules | `budget_input_sequence` |
| Player display name | At most 18 printable display characters and 64 received bytes | `budget_player_name` |
| One server event | 64 KiB encoded | `budget_server_event_bytes` |
| One authoritative snapshot | 64 KiB encoded | `budget_snapshot_bytes` |
| Level/bootstrap manifest over WebSocket | 512 KiB encoded; PNG bytes travel as digest-pinned HTTP assets | `budget_level_bootstrap_bytes` |
| Buffered outbound bytes | 256 KiB per connection, then deterministic slow-consumer disconnect | `budget_socket_backpressure` |
| Connections | 10 active players per room; an 11th rejects with policy code | `budget_connection_count` |
| Origin values | One exact configured HTTPS origin per release | `origin_rejected` |

A snapshot schema must have finite arrays implied by the room caps. The server never sends arbitrary producer strings, reports, filesystem paths, or content files through the gameplay WebSocket.

## 12. Telemetry, feedback, and story budgets

Telemetry is server-owned truth derived from bounded authoritative events. A producer may consume immutable context but cannot write telemetry truth.

| Output/input family | v1 limit | Stable rejection code |
| --- | --- | --- |
| Significant telemetry events | 4,096 per completed level | `budget_telemetry_event_count` |
| Aggregate telemetry fields | 256 closed numeric counters/histograms | `budget_telemetry_aggregate_count` |
| Histogram buckets | 32 per histogram | `budget_histogram_buckets` |
| Telemetry bundle | 1 MiB encoded NDJSON/JSON per level | `budget_telemetry_bytes` |
| Positional samples | At most 5 Hz/entity and 20,000 total; prefer aggregates | `budget_position_samples` |
| Player feedback records | At most one final record per slot, 10 total | `budget_feedback_count` |
| Feedback free text | 0–512 NFC code points and at most 2,048 bytes per player | `budget_feedback_text` |
| Feedback choices/tags | At most 8 closed choices and 8 identifiers per player | `budget_feedback_choices` |
| Complete feedback bundle | 32 KiB encoded | `budget_feedback_bytes` |
| Annotator story | At most 64 KiB encoded | `budget_story_bytes` |
| Story observations/beats | At most 32; each detail at most 512 code points/2,048 bytes | `budget_story_observations` |
| Story provenance | At most 4 KiB and 16 digest references | `budget_story_provenance` |
| Context history | Current result plus at most 3 prior sealed level summaries | `budget_context_history` |

When event volume reaches its cap, the Engine seals a deterministic `telemetry_truncated` aggregate and stops optional sampling. It never drops result, damage, death, completion, revision, replay, or activation truth. A candidate cannot request more telemetry or alter collection rates.

## 13. Time, validation, and generation-wait budgets

All authoritative timing uses fixed ticks or server-owned monotonic durations. Producer timestamps have no ordering authority.

| Time/resource | v1 limit | Stable rejection/runtime code |
| --- | --- | --- |
| Between-level candidate wait | At most 500 ticks / 10 seconds after result seal | `budget_generation_wait` |
| Total result-to-next-pin intermission | At most 600 ticks / 12 seconds | `runtime_intermission_timeout` |
| One candidate validation wall time | 3 seconds on the isolated validator worker | `budget_validation_wall_time` |
| One candidate validation CPU | 2 CPU-seconds | `budget_validation_cpu` |
| One validator memory | 256 MiB RSS | `budget_validation_memory` |
| One PNG decode | 100 ms CPU and bounded allocation after preflight | `budget_png_decode_cpu` |
| Solvability pass | 500 ms CPU plus deterministic operation cap | `budget_solvability_cpu` |
| Dry-run pass | 1 CPU-second plus 2,000-tick/2,000,000-operation cap | `budget_dry_run_cpu` |
| Staging reread/assembly | 2 seconds wall time | `budget_staging_wall_time` |
| Candidate age | One exact target boundary only; no rollover | `late_candidate` |
| Validator retries | 1 retry only for an Engine-owned transient before cutoff; same immutable bytes/receipt lineage | `budget_validator_retries` |

The Engine never waits for a producer or image generator beyond 10 seconds. Work that misses cutoff is rejected for that boundary and may only return as a newly manifested candidate for a later future boundary. Last-known-good content pins by 12 seconds even when every producer, validator, annotator, or image service is absent or failed.

## 14. Storage and retention caps

Safety references override ordinary retention caps. Intake and garbage collection fail closed before deleting protected bytes.

| Storage resource | v1 limit | Stable operational code |
| --- | --- | --- |
| Unreferenced rejected/quarantine bytes | 1 GiB per producer | `budget_quarantine_bytes` |
| Pending outbox bytes | 256 MiB per producer | `budget_outbox_bytes` |
| Unreferenced terminal receipts | Retain latest 10,000 plus all protected references | `budget_receipt_retention` |
| Unreferenced validated revisions | 64 per Engine scope | `budget_revision_retention` |
| Protected revisions | Active, pinned, immediate rollback, replay-, receipt-, release-, and recovery-referenced: no count-based deletion | `retention_reference_protected` |
| Minimum free filesystem reserve | 2 GiB and space for active + rollback + two maximum candidates | `budget_storage_reserve` |

Crossing an ordinary storage cap disables or rejects new intake and emits an operational receipt. It does not block level start/completion, mutate a pinned revision, or permit protected garbage collection.

## 15. Stable reason-code rules

- Each table row's code is the primary code for that violated bound.
- A value with the wrong primitive type uses `schema_invalid`; a correctly typed value outside the finite domain uses the table's `budget_*` code.
- An undeclared field uses `unknown_field`; a newly declared field with no reviewed mapping uses `budget_unmapped_field`.
- A local value may generate one local code and one aggregate code, but duplicate findings for the same pointer/code are removed.
- Derived deterministic work that exceeds a count uses its specific operation code. Worker wall/CPU/memory termination uses the specific validation resource code.
- Runtime cap codes are fatal deterministic room/release evidence, not permission to omit authoritative effects.
- Generic `budget_exceeded` may summarize a terminal receipt but never replaces the specific code in ordered findings.

No producer text selects, suppresses, renames, or downgrades a reason code.

## 16. Required implementation acceptance

Implementation cannot close this contract from prose alone. Automated and independent evidence must prove at least:

1. Every producer-controlled schema field maps to one finite table row and stable code; a generated schema-to-budget inventory has zero unmapped fields.
2. For every scalar/count/byte/time limit, tests accept the minimum and maximum valid values and reject one-below/one-above values with the exact code where representable.
3. Property/fuzz tests reject unknown keys, duplicate keys, invalid UTF-8, fractional/non-finite numbers, negative zero, sparse/oversized arrays, deep JSON, and node explosions without unbounded allocation.
4. File, JSON, PNG, decoded-byte, candidate, revision, request, report, and receipt limits hold both locally and in aggregate; splitting cannot evade them.
5. A real two-UID Linux flood fixture enables the exact 192 MiB/6,144-inode hard producer quota, fills staging to block and inode limits, creates 65 and then quota-maximum malformed ready names, and offers oversized sparse files. It proves kernel `EDQUOT`/`ENOSPC`, zero recursive staging work, no more than 65 names/64 metadata calls/16 opens/8 claims/512 syscalls/32 producer FDs in one pass, exact stable codes, no body read for oversized files, and an unchanged last-known-good pin by 12 seconds. The same fixture fails intake startup when quota enforcement is absent or inactive.
6. PNG header/chunk bombs, oversized dimensions, decompression bombs, animated/interlaced/trailing content, palette excess, and wrong pose/tile canvases reject before unsafe allocation.
7. A content set at every revision count maximum validates; adding one level, enemy, attack, projectile, pose pack, tile, backdrop, objective, or reference rejects under the exact code.
8. Level boundary fixtures cover width, height, layers, cells, colliders, markers, waves, spawns, waypoints, objectives, duration, and solvability operations at `N` and `N+1`.
9. Enemy/AI fixtures cover all stat ranges, 8 states, 24 transitions, condition/action counts, finite timers, random weights, path operations, and unsupported cycles/primitives.
10. Attack/projectile fixtures cover timing, hitboxes, damage, targets, live/total/per-tick projectiles, lifetime, speed, acceleration, pierce, and bounce at `N` and `N+1`.
11. The deterministic dry run meters every content-controlled loop and rejects before any per-tick operation cap can be exceeded in active play.
12. A worst-case accepted room with 10 players, 64 enemies, 256 projectiles, 256 pickups, and maximum bounded queries remains under all deterministic per-tick operation caps.
13. The pinned-host 10,000-tick performance fixture meets p95/p99/max tick SLOs, process/room memory limits, and produces the same replay digest across repeated runs.
14. Network tests enforce bytes before parse, JSON shape, message token bucket, snapshots, bootstrap, send backpressure, 10-player cap, and wrong-origin rejection.
15. Telemetry and feedback fixtures hit exact event/sample/text/bundle caps; optional sampling truncates deterministically while result/replay/damage/death/completion truth remains complete.
16. A missing/slow/crashed producer and a candidate still generating at 10 seconds cannot extend the 12-second intermission; the next level pins last-known-good content.
17. Validator wall/CPU/memory, PNG decode, solvability, dry-run, staging, and retry limits produce exact rejection receipts and no active-pointer change.
18. Storage saturation disables intake without deleting protected revisions or preventing last-known-good level start, play, finish, and transition.
19. Revalidation during staging recomputes every encoded and derived budget from immutable Engine-owned bytes and rejects disagreement.
20. Rejection reports contain at most 64 deterministically ordered findings, exact observed/allowed values, the profile ID, and no secrets/host paths/raw private feedback.
21. The actual Designer, image model, network, and annotator remain absent from the entire acceptance run; a deterministic fake writer is sufficient.

## 17. Explicit non-goals

This profile does not:

- implement schemas, validators, state machines, collision, pathfinding, telemetry, or the filesystem protocol;
- ship the actual Designer, image model, prompt set, annotator, or autonomous scheduler;
- authorize endless streaming, unbounded procedural generation, arbitrary polygons, arbitrary URLs, remote assets, executable content, scripts, plugins, or expression languages;
- allow copied Castlevania assets, photoreal/painterly final art, more than five semantic enemy poses, or sprite-sheet generation as a runtime dependency;
- make wall-clock host performance part of deterministic gameplay truth;
- allow a budget failure to block last-known-good play or mutate an active/pinned level;
- authorize deployment or mutation of the accepted production release.

## 18. Consequences

- Schema and runtime work has one finite v1 envelope with exact boundary fixtures and rejection codes.
- The maximum level, enemy, projectile, and art set is intentionally much larger than a normal level but small enough to preflight, meter, dry-run, and retain safely.
- Ten-player behavior remains supported while solo PvE remains complete.
- Five 64×64 semantic poses and 32×32 tiles remain the art contract; cosmetic motion comes from Engine/client presentation, not hundreds of generated frames.
- Generation and validation can miss a boundary without stalling play; last-known-good content wins by a fixed deadline.
- Future features that need larger or new fields require a new reviewed budget profile and Engine release rather than silent limit drift.
