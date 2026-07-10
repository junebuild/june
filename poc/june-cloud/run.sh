#!/usr/bin/env bash
# End-to-end demo of `june deploy` → june.cloud (creekd) → {deploy}-{slug}.june.app
#
# Boots a local dev-mode creekd + the June Cloud PoC (control plane + front-door),
# runs a deploy, then hits the minted hostname through the front-door and shows
# the June app answering. All local; no DNS/TLS/root needed (cgroup + namespaces
# self-skip on macOS — we're proving the deploy loop, not isolation).
#
# Point at a real Linux creekd instead by exporting CREEKD_BIN / the CREEKD_*
# addresses before running.
set -euo pipefail
cd "$(dirname "$0")"

BUN_BIN="${BUN_BIN:-$(command -v bun)}"
CREEKD_BIN="${CREEKD_BIN:-$HOME/Projects/creek/creekd/bin/creekd}"
TOKEN="${CREEKD_TOKEN:-poc-secret-token}"
DATA="$(pwd)/.data"
SLUG="${1:-acme}"

ADMIN=127.0.0.1:9080
DISPATCH=127.0.0.1:9000
CONTROL=127.0.0.1:8080
FRONTDOOR=127.0.0.1:8787

[ -x "$CREEKD_BIN" ] || { echo "✗ creekd binary not found at $CREEKD_BIN (build it: (cd ~/Projects/creek/creekd && go build -o bin/creekd ./cmd/creekd)) or set CREEKD_BIN"; exit 1; }
[ -n "$BUN_BIN" ] || { echo "✗ bun not found on PATH"; exit 1; }

rm -rf "$DATA"; mkdir -p "$DATA/state" "$DATA/logs"
PIDS=()
cleanup() { echo; echo "— shutting down —"; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_ready() { # url, name
  for _ in $(seq 1 50); do
    if curl -fsS -o /dev/null "$1" 2>/dev/null; then echo "  ✓ $2 ready"; return 0; fi
    sleep 0.2
  done
  echo "  ✗ $2 did not come up ($1)"; exit 1
}

echo "== 1. start creekd (dev mode) =="
CREEKD_ADMIN_ADDR="$ADMIN" CREEKD_ADMIN_TOKEN="$TOKEN" \
CREEKD_DISPATCH_ADDR="$DISPATCH" CREEKD_STATE_DIR="$DATA/state" \
CREEKD_LOG_DIR="$DATA/logs" \
  "$CREEKD_BIN" > "$DATA/creekd.log" 2>&1 &
PIDS+=($!)
wait_ready "http://$ADMIN/v1/hostkey" "creekd admin"

echo "== 2. start June Cloud (control plane + front-door) =="
CREEKD_ADMIN="http://$ADMIN" CREEKD_DISPATCH="http://$DISPATCH" CREEKD_TOKEN="$TOKEN" \
BUN_BIN="$BUN_BIN" CONTROL_PORT="${CONTROL##*:}" FRONTDOOR_PORT="${FRONTDOOR##*:}" \
  "$BUN_BIN" run cloud/server.ts > "$DATA/cloud.log" 2>&1 &
PIDS+=($!)
wait_ready "http://$CONTROL/v1/deployments" "june cloud"

echo "== 3. june deploy → creek (tenant: $SLUG) =="
"$BUN_BIN" run cli/june-deploy.ts --slug "$SLUG" --control "http://$CONTROL"

HOST="$(curl -fsS "http://$CONTROL/v1/deployments" | "$BUN_BIN" -e \
  'const d=await Bun.stdin.json(); process.stdout.write(d[d.length-1].host)')"

echo
echo "== 4. hit the minted hostname through the front-door =="
echo "   curl -H 'Host: $HOST' http://$FRONTDOOR/health"
echo -n "   → "; curl -fsS -H "Host: $HOST" "http://$FRONTDOOR/health"; echo
echo
echo "   curl -H 'Host: $HOST' http://$FRONTDOOR/  (first lines)"
curl -fsS -H "Host: $HOST" "http://$FRONTDOOR/" | grep -E 'Hello|tenant|deploy id|served by' | sed 's/<[^>]*>//g;s/^/   /'
echo
echo "✓ end-to-end: june deploy → creekd spawn → $HOST → front-door → creekd dispatch → June app"
echo "  (logs: $DATA/creekd.log, $DATA/cloud.log)"
echo
echo "Press Ctrl-C to tear down."
wait
