// Fetch the font files this package ships into fonts/, pinned and checksummed. They are not in
// git: a CJK weight is ~5.7 MB and every update would stay in the history forever. Run by
// `bun run build` (so by publish.yml) and by CI before the tests that need them; those tests
// skip, with a pointer here, when fonts/ is empty.
//
// Source: Noto Sans CJK's region-specific subset OTFs (Traditional Chinese, Taiwan), release
// Sans2.004, SIL Open Font License 1.1 (LICENSE, next to this package's package.json).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "Sans2.004";
const FILES: Record<string, string> = {
  "NotoSansTC-Regular.otf": "5bab0cb3c1cf89dde07c4a95a4054b195afbcfe784d69d75c340780712237537",
  "NotoSansTC-Bold.otf": "55420b259eb119bf5f2a0aadba10cf9d736c12d64ab93e78546d69ef5f43558b",
};

const dir = join(dirname(fileURLToPath(import.meta.url)), "../fonts");
mkdirSync(dir, { recursive: true });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

for (const [name, want] of Object.entries(FILES)) {
  const path = join(dir, name);
  if (existsSync(path) && sha256(readFileSync(path)) === want) continue;
  const url = `https://raw.githubusercontent.com/notofonts/noto-cjk/${TAG}/Sans/SubsetOTF/TC/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== want) throw new Error(`${name}: sha256 ${got}, expected ${want}`);
  writeFileSync(path, bytes);
  console.log(`fonts/${name}: ${(bytes.length / 1048576).toFixed(1)} MiB`);
}
