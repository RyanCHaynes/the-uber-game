# Coin Rush

Coin Rush is a browser-based two-player castle race rendered with Three.js. A
central Node server owns lobby state, movement, collision, coin placement,
scores, wins, and round reset over same-origin WebSockets.

The original native C++/SFML implementation is preserved at Git tag
`sfml-baseline-2026-07-18`.

## Architecture

- **Browser:** Three.js rendering and keyboard input only; no client-authoritative
  physics or scoring.
- **Backend:** one authoritative two-player `GameRoom`, 50 Hz physics, 20 Hz
  snapshots, bounded JSON messages, heartbeat, handshake timeout, origin check,
  and per-peer input-rate budget.
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

Open `http://127.0.0.1:3000` in two separate browser contexts, join both, and
ready both players.

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
rejected. A third concurrent connection is refused.

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
Remove its public TCP `53000` listener and firewall rule only after two-browser
WSS play acceptance succeeds.
