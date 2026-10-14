// @junejs/pdf-font-noto-sans-tc on Bun: each file is imported `with { type: "file" }`, so
// `bun build --compile` embeds it and the import yields its path inside the binary, the way
// @junejs/pdf-typst-wasm loads its engine (#367). Dynamic, with literal paths the bundler can
// see: read on the first render, never at import.

import { readFile } from "node:fs/promises";

import { createNotoSansTC, MISSING, type NotoSansTCOptions, type NotoSansTCWeight } from "./provider";

export type { NotoSansTCOptions, NotoSansTCWeight } from "./provider";

// fonts.d.ts types a .otf import as bytes (workerd's Data module); with type "file" it is a path.
type FileImport = Promise<unknown>;
const IMPORTS: Record<NotoSansTCWeight, () => FileImport> = {
  400: () => import("../fonts/NotoSansTC-Regular.otf", { with: { type: "file" } }),
  700: () => import("../fonts/NotoSansTC-Bold.otf", { with: { type: "file" } }),
};

export function notoSansTC(opts: NotoSansTCOptions = {}) {
  return createNotoSansTC(async (weight) => {
    let path: string;
    try {
      path = ((await IMPORTS[weight]()) as { default: string }).default;
    } catch (err) {
      throw new Error(MISSING, { cause: err });
    }
    return new Uint8Array(await readFile(path));
  }, opts);
}
