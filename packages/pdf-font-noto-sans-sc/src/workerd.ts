// @junejs/pdf-font-noto-sans-sc on Cloudflare Workers (the `workerd` export condition): the
// files are imported as Data modules, so wrangler uploads them with the Worker. The two weights
// add ~16 MiB to the Worker, next to the engine's 29 MiB, under the 64 MiB limit. Wrangler
// needs a rule for the extension; `june build` emits it (#379), and an app running wrangler
// on its own config adds it:
//
//   "rules": [{ "type": "Data", "globs": ["**/*.otf"], "fallthrough": true }]

import bold from "../fonts/NotoSansSC-Bold.otf";
import regular from "../fonts/NotoSansSC-Regular.otf";
import { createNotoSansSC, type NotoSansSCOptions } from "./provider";

export type { NotoSansSCOptions, NotoSansSCWeight } from "./provider";

export function notoSansSC(opts: NotoSansSCOptions = {}) {
  return createNotoSansSC(async (weight) => new Uint8Array(weight === 700 ? bold : regular), opts);
}
