#!/bin/sh
# Starts the app the way the README says to, against an empty instance, and checks that it
# serves the setup wizard. `local` runs the built server (run `npm run build` first);
# `docker` builds the image and runs it with `docker compose`.
#
#   scripts/smoke.sh local
#   scripts/smoke.sh docker
set -eu

mode=${1:-}
port=${SMOKE_PORT:-4399}
url="http://127.0.0.1:$port"
cd "$(dirname "$0")/.."

case "$mode" in
  local)
    [ -f dist/server/entry.mjs ] || { echo "dist/ is missing: run npm run build first" >&2; exit 1; }
    dir=$(mktemp -d)
    INSTANCE_DIR="$dir" PORT="$port" HOST=127.0.0.1 node dist/server/entry.mjs >"$dir/server.log" 2>&1 &
    pid=$!
    trap 'status=$?; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true; rm -rf "$dir"; exit $status' EXIT
    logs() { cat "$dir/server.log"; }
    ;;
  docker)
    project=nbst-smoke
    export NBST_PORT="$port"
    trap 'docker compose -p $project down -v >/dev/null 2>&1 || true' EXIT
    docker compose -p $project up -d --build
    logs() { docker compose -p $project logs; }
    ;;
  *)
    echo "usage: $0 local|docker" >&2
    exit 2
    ;;
esac

# Wait for the server to answer at all.
i=0
until curl -fsS -o /dev/null "$url/setup" 2>/dev/null; do
  i=$((i + 1))
  if [ $i -ge 60 ]; then
    echo "no answer from $url after 60 s" >&2
    logs >&2
    exit 1
  fi
  sleep 1
done

# An empty instance sends every page to the setup wizard.
location=$(curl -fsS -o /dev/null -w '%{redirect_url}' "$url/")
case "$location" in
  */setup) ;;
  *) echo "expected / to redirect to /setup, got '$location'" >&2; logs >&2; exit 1 ;;
esac

curl -fsS "$url/setup" | grep -q '<title>Set up' || {
  echo "/setup did not render the setup wizard" >&2
  logs >&2
  exit 1
}

echo "ok: $mode serves the setup wizard at $url"
