// `june deploy` (target: creek) — PoC stand-in.
//
// This is the shape of the new deploy target that grafts into
// packages/june/src/deploy.ts (see the README's "Graft point"). The existing
// juneDeploy() already dispatches on target (workers / vercel / deno / static);
// `creek` is one more branch:
//
//   1. `june build` the app (skipped here — the PoC ships app/ as-is)
//   2. POST the artifact reference to the June Cloud control plane
//   3. print the `{deploy}-{slug}.june.app` URL it returns
//
// Auth/tenant resolution is stubbed to a --slug flag; in production the slug is
// the caller's team, resolved from the June Cloud token.

import { resolve } from "node:path";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const control = arg("control", process.env.JUNE_CLOUD_CONTROL ?? "http://127.0.0.1:8080")!;
const slug = arg("slug", process.env.JUNE_TENANT_SLUG ?? "acme")!;
// Default to the PoC app dir (…/poc/june-cloud/app), relative to this file.
const appDir = resolve(arg("app-dir", new URL("../app", import.meta.url).pathname)!);
const entry = arg("entry", "server.ts")!;

console.log(`june deploy → creek`);
console.log(`  tenant : ${slug}`);
console.log(`  app    : ${appDir}/${entry}`);
console.log(`  cloud  : ${control}`);

const res = await fetch(`${control}/v1/deploy`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ slug, appDir, entry }),
});

const out = await res.json();
if (!res.ok) {
  console.error(`\n✗ deploy failed: ${out.error ?? res.status}`);
  process.exit(1);
}

console.log(`\n✓ deployed`);
console.log(`  ${out.url}`);
console.log(`  (creekd app id: ${out.appId}, internal port ${out.port})`);
