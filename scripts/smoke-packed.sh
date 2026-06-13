#!/usr/bin/env bash
# Packed-artifact E2E: the npm user's first session, against the TARBALLS this
# tree would publish (not the workspace, not the registry). Catches the class
# of bug that only exists outside the monorepo: phantom deps (rolldown,
# 0.0.6), broken bins, template wiring. CI runs this on every push.
set -euo pipefail

root=$(pwd)
work=$(mktemp -d)
trap 'pkill -f "june.ts dev" 2>/dev/null; rm -rf "$work"' EXIT

echo "→ packing workspace tarballs"
for p in core db june juno cli create-june; do
  (cd "packages/$p" && bun pm pack --quiet >/dev/null 2>&1)
  mv packages/$p/*.tgz "$work/"
done

echo "→ scaffolding from the packed create-june"
mkdir -p "$work/scaffold" && (cd "$work/scaffold" && tar -xzf "$work"/create-june-*.tgz)
node "$work/scaffold/package/bin.mjs" "$work/app" >/dev/null

echo "→ pointing the app at the packed tarballs (overrides cover transitives)"
python3 - "$work" <<'EOF'
import glob, json, sys
work = sys.argv[1]
tgz = {}
for f in glob.glob(f"{work}/*.tgz"):
    name = f.rsplit("/", 1)[1]
    if name.startswith("junejs-"):
        tgz["@junejs/" + name[len("junejs-"):].rsplit("-", 1)[0]] = f"file:{f}"
p = f"{work}/app/package.json"
d = json.load(open(p))
for section in ("dependencies", "devDependencies"):
    for k in list(d.get(section, {})):
        if k in tgz:
            d[section][k] = tgz[k]
d["overrides"] = tgz  # force transitive @junejs/* (cli → server → core) onto the tarballs
json.dump(d, open(p, "w"), indent=2)
EOF

cd "$work/app"
echo "→ npm install"
npm install --no-audit --no-fund >/dev/null

echo "→ june info"
npx june info | grep -q "Routes" || { echo "june info failed"; exit 1; }

echo "→ june dev"
npx june dev --port 4911 --no-watch &
sleep 6

curl -fsS http://localhost:4911/ >/dev/null
curl -fsS http://localhost:4911/client.js >/dev/null
curl -fsS http://localhost:4911/llms.txt >/dev/null
curl -fsS -X POST http://localhost:4911/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -q createUser

echo "packed e2e: OK (/, /client.js, /llms.txt, /mcp)"
