// @junejs/pdf-font-noto-sans-jp on Node and Deno: the font files are read from fonts/ next to
// this file's directory (the same path from src/ in the repo and dist/ in the package), on the
// renderer's first render.
//
//   import { notoSansJP } from "@junejs/pdf-font-noto-sans-jp";
//   typstWasmRenderer({ fonts: [notoSansJP()] });

import { readFile } from "node:fs/promises";

import { createNotoSansJP, FILES, MISSING, type NotoSansJPOptions } from "./provider";

export type { NotoSansJPOptions, NotoSansJPWeight } from "./provider";

export function notoSansJP(opts: NotoSansJPOptions = {}) {
  return createNotoSansJP(async (weight) => {
    try {
      return new Uint8Array(await readFile(new URL(`../fonts/${FILES[weight]}`, import.meta.url)));
    } catch (err) {
      throw new Error(MISSING, { cause: err });
    }
  }, opts);
}
