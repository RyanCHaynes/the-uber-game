#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this installer as root on the dedicated game VM." >&2
    exit 1
fi
for command in caddy curl docker systemctl; do
    command -v "$command" >/dev/null 2>&1 || {
        echo "Required command is missing: $command" >&2
        exit 1
    }
done
docker compose version >/dev/null

repository_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
compose_file="$repository_root/deploy/compose.yaml"
source_commit=${SOURCE_COMMIT:-archive}
image=${COINRUSH_IMAGE:-coinrush-web:$source_commit}

COINRUSH_IMAGE="$image" docker compose -p coinrush-threejs -f "$compose_file" config -q
COINRUSH_IMAGE="$image" docker compose -p coinrush-threejs -f "$compose_file" build
COINRUSH_IMAGE="$image" docker compose -p coinrush-threejs -f "$compose_file" up -d

container=$(COINRUSH_IMAGE="$image" \
    docker compose -p coinrush-threejs -f "$compose_file" ps -q coinrush-web)
health=starting
attempt=0
while [ "$attempt" -lt 30 ]; do
    health=$(docker inspect "$container" \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
    [ "$health" = healthy ] && break
    attempt=$((attempt + 1))
    sleep 1
done
if [ "$health" != healthy ]; then
    echo "Three.js backend did not become healthy (status: $health)." >&2
    exit 1
fi
curl -fsS --max-time 3 http://127.0.0.1:3000/healthz >/dev/null

caddy validate --config "$repository_root/deploy/Caddyfile"
install -m 0644 "$repository_root/deploy/Caddyfile" /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy

public_health=starting
attempt=0
while [ "$attempt" -lt 30 ]; do
    if public_health=$(curl -fsS --max-time 3 https://game.tinyfat.dev/healthz); then
        printf '%s' "$public_health" | grep -q '"ok":true' && break
    fi
    attempt=$((attempt + 1))
    sleep 2
done
if ! printf '%s' "$public_health" | grep -q '"ok":true'; then
    echo "Public HTTPS health check failed." >&2
    exit 1
fi

install -d -m 0755 /opt/coinrush
printf '%s\n' "$source_commit" >/opt/coinrush/THREEJS_SOURCE_COMMIT
chmod 0644 /opt/coinrush/THREEJS_SOURCE_COMMIT
printf 'Coin Rush Three.js %s is healthy at https://game.tinyfat.dev/\n' "$source_commit"
printf 'The preserved SFML service remains separate until browser QA accepts cutover.\n'
