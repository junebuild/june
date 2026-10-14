// @junejs/pdf-font-noto-sans-tc on Cloudflare Workers (the `workerd` export condition): the
// files are imported as Data modules, so wrangler uploads them with the Worker. The two weights
// add ~11 MiB to the Worker, next to the engine's 29 MiB, under the 64 MiB limit. Wrangler
// needs a rule for the extension in the app's wrangler config:
//
//   "rules": [{ "type": "Data", "globs": ["**/*.otf"] }]

import bold from "../fonts/NotoSansTC-Bold.otf";
import regular from "../fonts/NotoSansTC-Regular.otf";
import { createNotoSansTC, type NotoSansTCOptions } from "./provider";

export type { NotoSansTCOptions, NotoSansTCWeight } from "./provider";

export function notoSansTC(opts: NotoSansTCOptions = {}) {
  return createNotoSansTC(async (weight) => new Uint8Array(weight === 700 ? bold : regular), opts);
}
