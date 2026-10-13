#!/usr/bin/env bash
# Build and (re)start K-BAY. Safe to run again for every update.
#   first run : creates .env with random secrets, starts the stack, seeds OPPLOX / K-BAY and
#               prints each person's temporary password once.
#   later runs: rebuilds, applies new database migrations, restarts. Data is kept.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is not available (docker compose)."
command -v openssl >/dev/null || die "openssl is needed to generate secrets."

if [ ! -f .env ]; then
  say "Creating .env with fresh secrets"
  ip="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
  host="kbay.example.sslip.io"
  [ -n "$ip" ] && host="$(echo "$ip" | tr . -).sslip.io"
  cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_DB_PASSWORD=$(openssl rand -hex 24)
PUBLIC_URL=https://$host
APP_PORT=8090
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
BACKUP_KEEP_DAYS=30
BACKUP_AT_UTC_HOUR=22
ENV
  chmod 600 .env
fi
set -a; . ./.env; set +a

port="${APP_PORT:-8090}"
if ! docker compose ps --status running app 2>/dev/null | grep -q app; then
  if (command -v ss >/dev/null && ss -ltn "sport = :$port" | grep -q LISTEN); then
    die "Port $port is already used by something else on this server. Set APP_PORT in deploy/.env to a free port."
  fi
fi

if [ "${SKIP_BUILD:-}" = 1 ]; then
  say "Using the existing kbay-app image (SKIP_BUILD=1)"
else
  say "Building the K-BAY image"
  docker compose build app
fi

if [ -z "${VAPID_PUBLIC_KEY:-}" ]; then
  say "Generating web-push keys"
  keys="$(docker run --rm --entrypoint node kbay-app:latest -e "const k=require('web-push').generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")"
  sed -i "s|^VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=${keys%% *}|; s|^VAPID_PRIVATE_KEY=.*|VAPID_PRIVATE_KEY=${keys##* }|" .env
  set -a; . ./.env; set +a
fi

say "Starting database, app and backups"
mkdir -p backups
docker compose up -d

say "Waiting for the app to be healthy"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "${ok:-}" = 1 ] || { docker compose logs --tail=80 app; die "App did not become healthy."; }

if [ ! -f .seeded ]; then
  say "First run: seeding OPPLOX / K-BAY"
  docker compose exec -T app node dist/seed/seed.js | tee seed-output.txt
  chmod 600 seed-output.txt
  touch .seeded
  say "Temporary passwords are above and in deploy/seed-output.txt (readable by root only)."
  echo "Hand each person their own; they must set a new password at first sign-in. Then delete seed-output.txt."
fi

say "K-BAY is running on 127.0.0.1:$port"
echo "Public address (after the Caddy step): $PUBLIC_URL"
echo "Caddy site block: deploy/Caddyfile.kbay  (KBAY_HOST=${PUBLIC_URL#https://}, KBAY_PORT=$port)"
