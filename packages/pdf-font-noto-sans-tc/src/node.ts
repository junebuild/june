// @junejs/pdf-font-noto-sans-tc on Node and Deno: the font files are read from fonts/ next to
// this file's directory (the same path from src/ in the repo and dist/ in the package), on the
// renderer's first render.
//
//   import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
//   typstWasmRenderer({ fonts: [notoSansTC()] });

import { readFile } from "node:fs/promises";

import { createNotoSansTC, FILES, MISSING, type NotoSansTCOptions } from "./provider";

export type { NotoSansTCOptions, NotoSansTCWeight } from "./provider";

export function notoSansTC(opts: NotoSansTCOptions = {}) {
  return createNotoSansTC(async (weight) => {
    try {
      return new Uint8Array(await readFile(new URL(`../fonts/${FILES[weight]}`, import.meta.url)));
    } catch (err) {
      throw new Error(MISSING, { cause: err });
    }
  }, opts);
}
