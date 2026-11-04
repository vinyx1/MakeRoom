#!/usr/bin/env bash
# Starts MakeRoom, or restarts it if it's already running. Safe to run any time.
#
#   ./start.sh               Postgres, migrations, API and frontend, in the background
#   ./start.sh --test-card   same, with the sandbox test card on (needed for `npm run try`)
#   ./start.sh stop          stops the API and frontend (Postgres keeps running)
#   ./start.sh status        shows what's running, and changes nothing
#
# The API runs without --watch, so run this again to pick up server changes. The frontend reloads by itself.
# Logs: .run/server.log and .run/web.log

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PORT=3000
WEB_PORT=5177
LOGS="$ROOT/.run"

# This project's processes only: other projects can run their own Vite or a file with the same name.
find_pids() {
  local pid
  for pid in $(pgrep -f 'src/server/main\.ts' || true); do
    if [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$ROOT/server" ]; then
      echo "$pid"
    fi
  done
  pgrep -f "$ROOT/web/node_modules/\.bin/vite" || true
}

port_owner() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

stop_all() {
  local pids pid i
  pids="$(find_pids)"
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for i in 1 2 3 4 5 6; do
    [ -n "$(find_pids)" ] || return 0
    sleep 0.5
  done
  # The API's shutdown can hang on an open browser tab, so don't wait for it forever.
  for pid in $(find_pids); do
    kill -KILL "$pid" 2>/dev/null || true
  done
  sleep 0.5
}

wait_for_port() {
  local name="$1" port="$2" log="$3" i
  for i in $(seq 1 60); do
    if [ -n "$(port_owner "$port")" ]; then return 0; fi
    sleep 0.5
  done
  echo "$name didn't start on port $port. Last lines of $log:" >&2
  tail -20 "$log" >&2
  exit 1
}

TEST_CARD=0
case "${1:-}" in
  stop)
    stop_all
    echo "Stopped."
    exit 0
    ;;
  status)
    if [ -n "$(port_owner "$SERVER_PORT")" ]; then echo "API:      port $SERVER_PORT, up"; else echo "API:      port $SERVER_PORT, down"; fi
    if [ -n "$(port_owner "$WEB_PORT")" ]; then echo "Frontend: port $WEB_PORT, up"; else echo "Frontend: port $WEB_PORT, down"; fi
    echo "This project's processes: $(find_pids | tr '\n' ' ')"
    exit 0
    ;;
  --test-card) TEST_CARD=1 ;;
  "") ;;
  *)
    echo "Usage: ./start.sh [--test-card | stop | status]" >&2
    exit 1
    ;;
esac

for dir in server web; do
  if [ ! -d "$ROOT/$dir/node_modules" ]; then
    echo "Run npm install in $dir/ first." >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running. Start Docker Desktop and try again." >&2
  exit 1
fi

mkdir -p "$LOGS"
stop_all

for port in "$SERVER_PORT" "$WEB_PORT"; do
  owner="$(port_owner "$port")"
  if [ -n "$owner" ]; then
    echo "Port $port is in use by another program (pid $owner). Close it and try again." >&2
    exit 1
  fi
done

echo "Starting Postgres..."
(cd "$ROOT" && docker compose up -d --wait >/dev/null 2>&1) || (cd "$ROOT" && docker compose up -d >/dev/null)
for i in $(seq 1 30); do
  if (cd "$ROOT" && docker compose exec -T postgres pg_isready -U makeroom >/dev/null 2>&1); then break; fi
  if [ "$i" = 30 ]; then
    echo "Postgres didn't become ready." >&2
    exit 1
  fi
  sleep 1
done

echo "Running migrations..."
(cd "$ROOT/server" && npm run --silent db:migrate >"$LOGS/migrate.log" 2>&1) || {
  echo "Migrations failed:" >&2
  tail -20 "$LOGS/migrate.log" >&2
  exit 1
}

echo "Starting the API and frontend..."
if [ "$TEST_CARD" = 1 ]; then export DEV_TEST_CARD=1; fi
(cd "$ROOT/server" && nohup npm start >"$LOGS/server.log" 2>&1 &)
(cd "$ROOT/web" && nohup npm run dev >"$LOGS/web.log" 2>&1 &)

wait_for_port "The API" "$SERVER_PORT" "$LOGS/server.log"
wait_for_port "The frontend" "$WEB_PORT" "$LOGS/web.log"

echo
echo "MakeRoom is running on port $WEB_PORT (API on port $SERVER_PORT)."
if [ "$TEST_CARD" = 1 ]; then echo "Test card is on: use npm run try in server/."; fi
echo "Logs are in .run/. Stop it with ./start.sh stop."
