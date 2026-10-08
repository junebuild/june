#!/usr/bin/env bash
# The agent sandbox image, used the way an agent uses it: build it from flake.nix, load it into
# Docker, copy this tree in as the unprivileged `agent` user, then run every check CI runs on
# the plain toolchain. A pass means a coding agent dropped into the image can do the same.
#
#   bash scripts/smoke-sandbox-image.sh      # Linux with Nix and Docker
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

echo "→ building .#sandbox-image"
out=$(nix build ".#sandbox-image" --no-link --print-out-paths)
"$out" | docker load

echo "→ checks inside june-sandbox:latest"
docker run --rm -v "$root:/src:ro" june-sandbox:latest bash -euo pipefail -c '
  test "$(id -un)" = agent
  want=$(jq -r ".packageManager | sub(\"^bun@\"; \"\")" /src/package.json)
  test "$(bun --version)" = "$want" || { echo "bun $(bun --version), package.json wants $want"; exit 1; }

  # A fresh copy, owned by agent, without the host'"'"'s node_modules or build output.
  mkdir june
  tar -C /src --exclude=./node_modules --exclude="*/node_modules" --exclude="*/dist" -cf - . | tar -C june -xf -
  cd june

  bun install --frozen-lockfile
  bun run ci
  bun scripts/smoke-workerd.ts
  node --conditions=source --import tsx scripts/smoke-node.ts
  bash scripts/smoke-packed.sh
'
echo "sandbox image smoke: OK"
