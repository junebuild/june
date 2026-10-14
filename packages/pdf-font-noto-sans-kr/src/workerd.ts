// @junejs/pdf-font-noto-sans-kr on Cloudflare Workers (the `workerd` export condition): the
// files are imported as Data modules, so wrangler uploads them with the Worker. The two weights
// add ~9 MiB to the Worker, next to the engine's 29 MiB, under the 64 MiB limit. Wrangler
// needs a rule for the extension; `june build` emits it (#379), and an app running wrangler
// on its own config adds it:
//
//   "rules": [{ "type": "Data", "globs": ["**/*.otf"], "fallthrough": true }]

import bold from "../fonts/NotoSansKR-Bold.otf";
import regular from "../fonts/NotoSansKR-Regular.otf";
import { createNotoSansKR, type NotoSansKROptions } from "./provider";

export type { NotoSansKROptions, NotoSansKRWeight } from "./provider";

export function notoSansKR(opts: NotoSansKROptions = {}) {
  return createNotoSansKR(async (weight) => new Uint8Array(weight === 700 ? bold : regular), opts);
}
