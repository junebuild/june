// @junejs/pdf-font-noto-sans-jp on Cloudflare Workers (the `workerd` export condition): the
// files are imported as Data modules, so wrangler uploads them with the Worker. The two weights
// add ~9 MiB to the Worker, next to the engine's 29 MiB, under the 64 MiB limit. Wrangler
// needs a rule for the extension; `june build` emits it (#379), and an app running wrangler
// on its own config adds it:
//
//   "rules": [{ "type": "Data", "globs": ["**/*.otf"], "fallthrough": true }]

import bold from "../fonts/NotoSansJP-Bold.otf";
import regular from "../fonts/NotoSansJP-Regular.otf";
import { createNotoSansJP, type NotoSansJPOptions } from "./provider";

export type { NotoSansJPOptions, NotoSansJPWeight } from "./provider";

export function notoSansJP(opts: NotoSansJPOptions = {}) {
  return createNotoSansJP(async (weight) => new Uint8Array(weight === 700 ? bold : regular), opts);
}
