#!/usr/bin/env bash
#
# Brings the clinic system up on this machine:
#   1. a Node version the toolchain supports
#   2. Postgres in Docker
#   3. migrations (and a seed on a completely empty database)
#   4. the API and the Vite dev server, in the background, logging to .run/
#
# Safe to run repeatedly. Stop everything with ./stop.sh.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
mkdir -p .run

# ---------------------------------------------------------------- Node -----
# This machine's system Node is older than the installed npm supports, so the
# pinned version in .nvmrc is loaded first when nvm is available.
if [ -z "${NVM_DIR:-}" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
fi
if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  nvm use >/dev/null 2>&1 || true
fi

node_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    process.exit(maj >= 22 || (maj === 20 && min >= 17) ? 0 : 1);
  ' 2>/dev/null
}

if ! node_is_supported; then
  echo "Node 20.17+ or 22.9+ is required, but 'node' is $(node -v 2>/dev/null || echo 'missing')." >&2
  echo "Install it (nvm install $(cat .nvmrc 2>/dev/null || echo 22)) and re-run this script." >&2
  exit 1
fi
echo "node $(node -v)  npm $(npm -v)"

if [ ! -d node_modules ]; then
  echo "installing dependencies…"
  npm install
fi

# ---------------------------------------------------------- Database ------
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run Postgres." >&2
  exit 1
fi

docker compose up -d db >/dev/null

# DB_USER/DB_NAME mirror docker-compose.yml; change both places together.
for _ in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U hms -d hms >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! docker compose exec -T db pg_isready -U hms -d hms >/dev/null 2>&1; then
  echo "Postgres did not become ready on 127.0.0.1:5433." >&2
  exit 1
fi
echo "postgres ready (127.0.0.1:5433)"

npm run db:migrate --silent

if [ "$(docker compose exec -T db psql -U hms -d hms -tA -c 'select exists(select 1 from staff)')" = "f" ]; then
  echo "empty database — seeding the demo clinic…"
  npm run db:seed --silent
fi

# ------------------------------------------------------------ Servers -----
API_PORT="$(sed -n 's/^PORT=\(.*\)/\1/p' .env 2>/dev/null || true)"
API_PORT="${API_PORT:-8080}"
CLIENT_PORT=5173

if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1 ||
   ss -ltn 2>/dev/null | grep -q ":$API_PORT "; then
  echo "something is already listening on :$API_PORT — run ./stop.sh first." >&2
  exit 1
fi

cd "$ROOT/server"
nohup ../node_modules/.bin/tsx watch src/index.ts >"../.run/api.log" 2>&1 &
echo $! >"../.run/api.pid"
cd "$ROOT/client"
nohup ../node_modules/.bin/vite --port "$CLIENT_PORT" --strictPort >"../.run/client.log" 2>&1 &
echo $! >"../.run/client.pid"
cd "$ROOT"

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then
  echo "API did not start; last lines of .run/api.log:" >&2
  tail -20 .run/api.log >&2
  exit 1
fi

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$CLIENT_PORT/" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

echo
echo "  client  http://localhost:$CLIENT_PORT"
echo "  api     http://localhost:$API_PORT/api/health"
echo "  logs    .run/api.log  .run/client.log"
echo
echo "Sign in with a seeded account (see README) — every demo login uses the"
echo "password Clinic#2026 until you replace the seeded staff."
