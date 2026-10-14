// @junejs/pdf-font-noto-sans-sc on Node and Deno: the font files are read from fonts/ next to
// this file's directory (the same path from src/ in the repo and dist/ in the package), on the
// renderer's first render.
//
//   import { notoSansSC } from "@junejs/pdf-font-noto-sans-sc";
//   typstWasmRenderer({ fonts: [notoSansSC()] });

import { readFile } from "node:fs/promises";

import { createNotoSansSC, FILES, MISSING, type NotoSansSCOptions } from "./provider";

export type { NotoSansSCOptions, NotoSansSCWeight } from "./provider";

export function notoSansSC(opts: NotoSansSCOptions = {}) {
  return createNotoSansSC(async (weight) => {
    try {
      return new Uint8Array(await readFile(new URL(`../fonts/${FILES[weight]}`, import.meta.url)));
    } catch (err) {
      throw new Error(MISSING, { cause: err });
    }
  }, opts);
}
