#!/usr/bin/env bash
#
# Stops the API and the client started by ./start.sh.
#
#   ./stop.sh        stop the app processes (Postgres keeps running)
#   ./stop.sh --db   also stop the Postgres container
#
# The database is left up on purpose: an admission or an invoice should not
# disappear because a laptop was restarted and nobody ran start.sh again.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

API_PORT="$(sed -n 's/^PORT=\(.*\)/\1/p' .env 2>/dev/null || true)"
API_PORT="${API_PORT:-8080}"
CLIENT_PORT=5173

stop_pid() {
  local name="$1" pidfile=".run/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid
  pid="$(cat "$pidfile")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    echo "stopped $name (pid $pid)"
  fi
  rm -f "$pidfile"
}

stop_pid api
stop_pid client

# tsx watch and vite both spawn children that hold the listening socket. Sweep
# the ports so a crashed or orphaned run cannot block the next ./start.sh.
for port in "$API_PORT" "$CLIENT_PORT"; do
  for pid in $(ss -ltnp 2>/dev/null | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    kill "$pid" 2>/dev/null && echo "released :$port (pid $pid)"
  done
done

if [ "${1:-}" = "--db" ]; then
  docker compose stop db >/dev/null 2>&1 && echo "stopped postgres"
fi

echo "done."
