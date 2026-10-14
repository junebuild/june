// @junejs/pdf-font-noto-sans-kr on Node and Deno: the font files are read from fonts/ next to
// this file's directory (the same path from src/ in the repo and dist/ in the package), on the
// renderer's first render.
//
//   import { notoSansKR } from "@junejs/pdf-font-noto-sans-kr";
//   typstWasmRenderer({ fonts: [notoSansKR()] });

import { readFile } from "node:fs/promises";

import { createNotoSansKR, FILES, MISSING, type NotoSansKROptions } from "./provider";

export type { NotoSansKROptions, NotoSansKRWeight } from "./provider";

export function notoSansKR(opts: NotoSansKROptions = {}) {
  return createNotoSansKR(async (weight) => {
    try {
      return new Uint8Array(await readFile(new URL(`../fonts/${FILES[weight]}`, import.meta.url)));
    } catch (err) {
      throw new Error(MISSING, { cause: err });
    }
  }, opts);
}
