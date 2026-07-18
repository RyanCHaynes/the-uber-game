# Coin Rush

Coin Rush is a browser game with a mode selector. **Singleplayer** opens the
Token Rush crypt slice; **Multiplayer** opens the preserved two-to-ten-player
Three.js castle race. One central Node server owns both simulations over
separate same-origin WebSocket routes.

The original native C++/SFML implementation is preserved at Git tag
`sfml-baseline-2026-07-18`.

## Architecture

- **Start screen:** `/` links to `/singleplayer.html` and `/multiplayer.html`;
  neither authority socket opens before the player chooses a mode.
- **Singleplayer browser:** bounded 2D Token Rush rendering and intent input on
  `/slice-ws`; no client-authoritative movement, combat, collection, or finish.
- **Multiplayer browser:** Three.js rendering and keyboard input on `/ws`; no
  client-authoritative physics or scoring.
- **Backend:** one authoritative 2–10-player `GameRoom` plus one isolated
  authoritative `SoloSliceRoom`, 50 Hz physics, bounded JSON messages, heartbeat,
  handshake timeout, origin check, deterministic multiplayer slots/spawns, and
  per-peer input-rate budgets.
- **Levels:** immutable versioned data sent by the server before `gameStart`.
  Candidate revisions are bounded and validated before publication.
- **Ingress:** Caddy terminates HTTPS/WSS and proxies to Node on
  `127.0.0.1:3000`. The backend is not publicly bound.

## Local development

Requires Node 22.12 or newer.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm start
```

Open `http://127.0.0.1:3000`, choose Singleplayer for Token Rush, or open the
Multiplayer entry in 2–10 separate browser contexts, join them, and ready every
connected player.

## Protocol

Browser messages:

- `hello` with a player name
- `ready` with a boolean state
- `input` with boolean `up`, `down`, `left`, and `right`

Server messages:

- `welcome`, `lobby`, and `notice`
- a complete validated `level` revision
- `gameStart`
- authoritative `snapshot` state

Unknown, malformed, binary, oversized, wrong-origin, and over-rate traffic is
rejected. An eleventh concurrent connection is refused.

## Token Rush JSON content

`content/token-rush-level.json` owns the fixed `48×22` grid, solid rectangles,
enemy placements, and tokens. `content/token-rush-enemies.json` owns the enemy
catalog selected by those placements. The `token-rush-enemies/v2` contract
supports bounded nested body trees with independent HP, deterministic live
subtree detachment, finite-state movement controllers, and phased attached
melee hit volumes. Destroyed parts disappear. Projectiles are not accepted.

The engine retains fixed-tick authority, collision resolution, gravity, speed
ceilings, world bounds, and interpreter budgets. JSON cannot contain scripts,
URLs, arbitrary paths, eval, or unbounded loops. Both files are validated and
revision-pinned before room creation. The separate
`content/token-rush-enemy-demo-level.json` places the multipart Ossuary
Colossus without changing the frozen learned-level bytes. Invalid or oversized
content selects the bundled known-good catalog/level and reports stable
rejection codes through `/slice-healthz`. See
[`docs/token-rush-enemies-v2.md`](docs/token-rush-enemies-v2.md).

## Fixed level feedback loop

`npm run evaluate:token-rush` replays every line of
`content/token-rush-learning/history.jsonl` through one frozen authoritative
controller, seed, evaluator, and score formula. Each append-only line records
the level hash, completion, deaths, damage, tokens, ticks, score, prior-run
memory, and one durable lesson. The bounded Designer can only move an enemy or
token in level JSON. Its memory-withheld control uses the byte-identical source,
Designer, seed, method, and edit limits as the paired learned candidate, differing
only by omitted prior feedback. Every trial binds source, input, memory, method,
limits, and output hashes. The command fails closed on result drift, mismatched
control inputs, non-improving mainline trials, a learned candidate that does not
beat its matched control, or an active level that is not byte-identical to the
latest mainline trial. It does not add a service, protocol, runtime generator,
or executable level behavior.

## Dedicated deployment

The approved host is a separate 1 vCPU / 1 GB VM. `game.tinyfat.dev` is an
unproxied DNS `A` record to that VM so Caddy can terminate HTTPS directly.

From an exact source release on the VM:

```sh
sudo SOURCE_COMMIT="<full-git-sha>" \
  COINRUSH_IMAGE="coinrush-web:<short-git-sha>" \
  ./deploy/install-release.sh
```

The installer builds the pinned image, runs tests during the image build,
starts a non-root/read-only/capability-free container bound only to localhost,
waits for container health, validates and reloads Caddy, then verifies public
HTTPS health.

The preserved SFML service is intentionally not removed by the installer.
Remove its public TCP `53000` listener and firewall rule only after independent
real-browser WSS play acceptance succeeds.
