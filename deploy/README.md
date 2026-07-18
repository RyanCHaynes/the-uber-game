# Dedicated server deployment

Coin Rush uses a native SFML client and an authoritative raw TCP server. The
server cannot run on static hosting, an HTTP-only serverless platform, or a
WebSocket-only edge runtime. Run it on a small, separate Linux VM instead.

The current server handles one two-player lobby and needs very little memory.
A 1 vCPU / 1 GB disposable VM is ample for the hackathon demo. Do not place it
on a host with unrelated production workloads.

## Security boundary

The protocol is unencrypted and unauthenticated. Treat this as a short-lived
demo service for non-sensitive game traffic. The container:

- runs as UID/GID `65532`, not root;
- has a read-only root filesystem and no Linux capabilities;
- receives no host filesystem mounts or secrets;
- is limited to 0.5 CPU, 128 MiB RAM, and 64 processes; and
- publishes only TCP port `53000`.

The server currently bundles one static level. Agent-generated level delivery
requires a separate protocol change; this deployment does not claim that
feature yet.

## DNS and Caddy

Create an **unproxied** `A` record from `game.tinyfat.dev` directly to the game
VM. Native clients connect to `game.tinyfat.dev:53000`; ordinary Caddy and
Cloudflare HTTP proxying cannot carry the SFML raw TCP protocol.

Caddy serves only the HTTPS connection card and `/healthz` on ports 80/443. The
game container remains the central authoritative backend on TCP 53000. No
level-generation worker port should be public.

## Build and test

From the repository root:

```sh
docker compose -f deploy/compose.yaml build

docker run --rm --network none \
  --entrypoint /app/CoinRush \
  coinrush-server:local --level-test

docker run --rm \
  --entrypoint /app/CoinRush \
  coinrush-server:local --smoke-test
```

Expected results include `Level test passed` and `Network smoke test passed`.

## Install a release

On the dedicated Ubuntu VM, after installing Docker, Compose, and Caddy, run
from the repository root:

```sh
sudo SOURCE_COMMIT="$(git rev-parse --short HEAD)" \
  COINRUSH_IMAGE="coinrush-server:$(git rev-parse --short HEAD)" \
  ./deploy/install-release.sh
```

The installer builds the image, runs both smoke tests, starts the hardened
Compose service, waits for container health, and installs/reloads the Caddy
connection card. It fails before publication if a build or test fails.

For a source archive without `.git`, supply its recorded commit as
`SOURCE_COMMIT` explicitly.

## Start manually

```sh
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs --tail=50
```

Clients connect to the VM's public IPv4 address on port `53000`.

To use another host port, set `COINRUSH_PORT`. To bind privately for local
verification, set `COINRUSH_BIND_ADDRESS=127.0.0.1`.

## Host firewall

Preserve SSH access before enabling a deny-by-default firewall. On Ubuntu with
OpenSSH and UFW:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 53000/tcp
sudo ufw enable
sudo ufw status verbose
```

Do not expose Docker's API or any generation-worker port. If the host already
has firewall policy, adapt the rule instead of replacing that policy.

## Update and rollback

Build a revision-tagged image and start it explicitly:

```sh
COINRUSH_IMAGE=coinrush-server:<git-sha> \
  docker compose -f deploy/compose.yaml build
COINRUSH_IMAGE=coinrush-server:<git-sha> \
  docker compose -f deploy/compose.yaml up -d
```

Rollback by repeating `up -d` with the prior image tag. Stop and remove the
demo service with:

```sh
docker compose -f deploy/compose.yaml down
```
