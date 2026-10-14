// @junejs/pdf-font-noto-sans-jp on Bun: each file is imported `with { type: "file" }`, so
// `bun build --compile` embeds it and the import yields its path inside the binary, the way
// @junejs/pdf-typst-wasm loads its engine (#367). Dynamic, with literal paths the bundler can
// see: read on the first render, never at import.

import { readFile } from "node:fs/promises";

import { createNotoSansJP, MISSING, type NotoSansJPOptions, type NotoSansJPWeight } from "./provider";

export type { NotoSansJPOptions, NotoSansJPWeight } from "./provider";

// fonts.d.ts types a .otf import as bytes (workerd's Data module); with type "file" it is a path.
type FileImport = Promise<unknown>;
const IMPORTS: Record<NotoSansJPWeight, () => FileImport> = {
  400: () => import("../fonts/NotoSansJP-Regular.otf", { with: { type: "file" } }),
  700: () => import("../fonts/NotoSansJP-Bold.otf", { with: { type: "file" } }),
};

export function notoSansJP(opts: NotoSansJPOptions = {}) {
  return createNotoSansJP(async (weight) => {
    let path: string;
    try {
      path = ((await IMPORTS[weight]()) as { default: string }).default;
    } catch (err) {
      throw new Error(MISSING, { cause: err });
    }
    return new Uint8Array(await readFile(path));
  }, opts);
}
