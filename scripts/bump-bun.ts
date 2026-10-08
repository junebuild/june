// `bun scripts/bump-bun.ts <version>` — move the repo to a Bun release.
//
// Bun's version has ONE source: `packageManager` in the root package.json. CI's setup-bun
// reads it, and so does flake.nix. Nix additionally needs each release asset's hash, which
// lives in nix/bun.json; this script rewrites both from the release's own SHASUMS256.txt, so
// the hashes are Bun's published ones, not whatever a download happened to return.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The Nix systems the flake supports → the release asset each one installs. x86_64-linux uses
// the baseline build (no AVX2 requirement), as nixpkgs does.
const ASSETS = {
  "aarch64-darwin": "bun-darwin-aarch64.zip",
  "aarch64-linux": "bun-linux-aarch64.zip",
  "x86_64-linux": "bun-linux-x64-baseline.zip",
} as const;

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: bun scripts/bump-bun.ts <version>   (e.g. 1.4.3)");
  process.exit(1);
}

const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`${url}: HTTP ${res.status}. Is bun-v${version} a published release?`);
  process.exit(1);
}
const sums = new Map(
  (await res.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([hex, file]) => [file, hex]),
);

const hashes: Record<string, string> = {};
for (const [system, asset] of Object.entries(ASSETS)) {
  const hex = sums.get(asset);
  if (!hex) {
    console.error(`SHASUMS256.txt for ${version} has no ${asset}`);
    process.exit(1);
  }
  // Nix's fetchurl takes an SRI hash of the file itself: sha256-<base64>.
  hashes[system] = `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
}

// Validate both files before writing either: a half-applied bump leaves nix/bun.json and
// packageManager disagreeing, which the flake refuses to evaluate.
const root = join(import.meta.dir, "..");
const pkgPath = join(root, "package.json");
const pkg = readFileSync(pkgPath, "utf8");
const PACKAGE_MANAGER = /("packageManager":\s*")bun@[^"]+(")/;
if (!PACKAGE_MANAGER.test(pkg)) {
  console.error('package.json has no "packageManager": "bun@…" field to update');
  process.exit(1);
}

// Rewrite only the packageManager line, so the rest of package.json keeps its formatting.
writeFileSync(pkgPath, pkg.replace(PACKAGE_MANAGER, `$1bun@${version}$2`));
writeFileSync(join(root, "nix", "bun.json"), `${JSON.stringify({ version, hashes }, null, 2)}\n`);

console.log(`Bun ${version}: package.json packageManager and nix/bun.json updated.`);
console.log("Also bump @types/bun to match, then run bun install and bun run ci.");
