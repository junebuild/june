#!/usr/bin/env bash
# Smoke test for the runtime-next apploader: the SAME app, on the LATEST
# deno_core (0.403) with real WHATWG fetch. Proves the upgrade keeps every
# npm-capability marker AND adds a working server-side fetch.
#
# Run from the repo root: bash runtime-next/dev/smoke.sh
# (The binary reads runtime/app + runtime/dist relative to cwd, so it exercises
# the real app; runtime/ itself is never modified.)
set -u
PORT="${PORT:-3408}"
BIN="runtime-next/target/release/apploader"

if [ ! -x "$BIN" ]; then
  echo "smoke: building runtime-next apploader..."
  cargo build --release --manifest-path runtime-next/Cargo.toml --bin apploader >/dev/null 2>&1 \
    || { echo "build failed"; exit 1; }
fi

# Temp fetch route (real network call during SSR), cleaned up on exit.
FT="runtime/app/_fetchtest"
mkdir -p "$FT"
cat > "$FT/page.tsx" <<'TSX'
export default async function FetchTest() {
  try {
    const res = await fetch("https://example.com");
    const text = await res.text();
    return <main><pre id="r">{`fetch-ok status=${res.status} ct=${res.headers.get("content-type")?.split(";")[0]} h1=${text.includes("<h1>")} req=${typeof Request} hdr=${typeof Headers} res=${typeof Response}`}</pre></main>;
  } catch (e) {
    return <main><pre id="r">{"fetch-err: " + (e as Error).message}</pre></main>;
  }
}
TSX
cleanup() { rm -rf "$FT"; [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; }
trap cleanup EXIT

JUNE_DEV=0 PORT="$PORT" POOL=1 "$BIN" >/tmp/june-next-smoke.log 2>&1 &
SRV=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done

HTML="$(curl -s --max-time 10 "http://127.0.0.1:$PORT/")"
fail=0
check() { if printf '%s' "$HTML" | grep -qF -- "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1 (missing: $2)"; fail=1; fi; }

echo "=== runtime-next smoke (deno_core 0.403 + real fetch) ==="
check "RSC client component + hydration (Counter)" 'count: <!-- -->3'
check "pure npm ESM/CJS (clsx) + React-dep (zustand)" 'zustand n=<!-- -->0'
check "node builtins (buffer polyfill)"               'buffer=<!-- -->4a756e65'
check "global process shim"                           'proc=<!-- -->browser'
check "CSS-in-JS (emotion class)"                      'css-'
check "CSS import (head-injected style)"               'data-june-css'
check "CSS module (scoped class)"                      'class="box_c'
check "server action (LiveCounter)"                   'server-incremented'

FETCH="$(curl -s --max-time 15 "http://127.0.0.1:$PORT/_fetchtest")"
RESULT="$(printf '%s' "$FETCH" | grep -oE 'fetch-(ok|err)[^<]*' | head -1)"
if printf '%s' "$FETCH" | grep -qF 'fetch-ok'; then
  echo "  PASS  real WHATWG fetch during SSR  ($RESULT)"
else
  echo "  FAIL  real WHATWG fetch during SSR  ($RESULT)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then echo "=== SMOKE PASS ==="; else echo "=== SMOKE FAIL (see /tmp/june-next-smoke.log) ==="; fi
exit "$fail"
