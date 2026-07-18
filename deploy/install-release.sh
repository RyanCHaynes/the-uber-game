#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this installer as root on the dedicated game VM." >&2
    exit 1
fi

for command in caddy curl docker systemctl; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "Required command is missing: $command" >&2
        exit 1
    fi
done

docker compose version >/dev/null

repository_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
compose_file="$repository_root/deploy/compose.yaml"
source_commit=${SOURCE_COMMIT:-archive}
image=${COINRUSH_IMAGE:-coinrush-server:$source_commit}
bind_address=${COINRUSH_BIND_ADDRESS:-0.0.0.0}
port=${COINRUSH_PORT:-53000}

COINRUSH_IMAGE="$image" \
    docker compose -p coinrush -f "$compose_file" config -q
COINRUSH_IMAGE="$image" \
    docker compose -p coinrush -f "$compose_file" build

docker run --rm --network none "$image" --level-test
docker run --rm "$image" --smoke-test

COINRUSH_IMAGE="$image" \
COINRUSH_BIND_ADDRESS="$bind_address" \
COINRUSH_PORT="$port" \
    docker compose -p coinrush -f "$compose_file" up -d

container=$(COINRUSH_IMAGE="$image" \
    docker compose -p coinrush -f "$compose_file" ps -q coinrush-server)
health=starting
attempt=0
while [ "$attempt" -lt 20 ]; do
    health=$(docker inspect "$container" \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
    [ "$health" = healthy ] && break
    attempt=$((attempt + 1))
    sleep 1
done
if [ "$health" != healthy ]; then
    echo "Coin Rush container did not become healthy (status: $health)." >&2
    exit 1
fi

caddy validate --config "$repository_root/deploy/Caddyfile"
install -d -m 0755 /srv/coinrush-status
install -m 0644 "$repository_root/deploy/status/index.html" \
    /srv/coinrush-status/index.html
install -m 0644 "$repository_root/deploy/Caddyfile" /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy

https_health=starting
attempt=0
while [ "$attempt" -lt 30 ]; do
    if https_health=$(curl -fsS --max-time 3 \
        https://game.tinyfat.dev/healthz); then
        [ "$https_health" = ok ] && break
    fi
    attempt=$((attempt + 1))
    sleep 2
done
if [ "$https_health" != ok ]; then
    echo "Caddy HTTPS health check failed." >&2
    exit 1
fi

install -d -m 0755 /opt/coinrush
printf '%s\n' "$source_commit" >/opt/coinrush/SOURCE_COMMIT
chmod 0644 /opt/coinrush/SOURCE_COMMIT

printf 'Coin Rush %s is healthy.\n' "$source_commit"
printf 'Native clients: game.tinyfat.dev:%s\n' "$port"
printf 'HTTPS card: https://game.tinyfat.dev/\n'
