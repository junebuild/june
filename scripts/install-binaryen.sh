#!/usr/bin/env bash
# Install binaryen's wasm-opt, pinned and checksummed, for building @junejs/pdf-typst-wasm's
# engine (packages/pdf-typst-wasm/scripts/build-wasm.ts). Used by CI's pdf-engine job and by
# publish.yml. Linux x86_64 only — the runners both workflows use.
#
# Usage: bash scripts/install-binaryen.sh [install-dir]   (default: $RUNNER_TEMP or /tmp)
# Prints the bin directory; on GitHub Actions it is also appended to $GITHUB_PATH.
set -euo pipefail

VERSION=version_130 # released 2026-06-01
SHA256=0a18362361ad05465118cd8eeb72edaeec89de6894bc283576ef4e07aa3babcc

dir="${1:-${RUNNER_TEMP:-/tmp}}/binaryen"
url="https://github.com/WebAssembly/binaryen/releases/download/$VERSION/binaryen-$VERSION-x86_64-linux.tar.gz"
mkdir -p "$dir"
curl -sSfL -o "$dir/binaryen.tar.gz" "$url"
echo "$SHA256  $dir/binaryen.tar.gz" | sha256sum -c --quiet
tar xzf "$dir/binaryen.tar.gz" -C "$dir"
bin="$dir/binaryen-$VERSION/bin"
"$bin/wasm-opt" --version >&2
[ -n "${GITHUB_PATH:-}" ] && echo "$bin" >> "$GITHUB_PATH"
echo "$bin"
