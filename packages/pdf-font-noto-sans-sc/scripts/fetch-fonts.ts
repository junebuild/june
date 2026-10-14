// Fetch the font files this package ships into fonts/, pinned and checksummed. They are not in
// git: a CJK weight is ~8.0 MiB and every update would stay in the history forever. Run by
// `bun run build` (so by publish.yml) and by CI before the tests that need them; those tests
// skip, with a pointer here, when fonts/ is empty.
//
// Source: Noto Sans CJK's region-specific subset OTFs (Simplified Chinese, mainland China), SIL Open
// Font License 1.1 (LICENSE, next to this package's package.json). The release, names, sizes
// and hashes are NOTO_SANS_SC in src/provider.ts, which the unbundled entry checks too.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NOTO_SANS_SC } from "../src/provider.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../fonts");
mkdirSync(dir, { recursive: true });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

for (const { name, sha256: want, urls } of Object.values(NOTO_SANS_SC)) {
  const path = join(dir, name);
  if (existsSync(path) && sha256(readFileSync(path)) === want) continue;
  const url = urls[0]!;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== want) throw new Error(`${name}: sha256 ${got}, expected ${want}`);
  writeFileSync(path, bytes);
  console.log(`fonts/${name}: ${(bytes.length / 1048576).toFixed(1)} MiB`);
}
