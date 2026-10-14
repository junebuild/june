// notoSansSC — a FontProvider (@junejs/pdf-typst-wasm) for Simplified Chinese that needs no
// network: Noto Sans CJK's mainland China subset, regular and bold, shipped in this package (#371).
// The offline alternative to googleFontSubsets, which sends each document's characters to
// Google: here egress is empty and the cost is size instead, ~8.0 MiB per weight, registered
// once per renderer.
//
// The subset is not every CJK ideograph. Measured with fontTools: 30,890 code points, 27,900
// of them Han, and every GBK character but one symbol (U+2252), which Typst's embedded fonts
// cover.
// A rare character outside it (𪚥) is reported by the renderer's missing glyphs check
// like any other.
//
// Each runtime finds the files its own way (node.ts, bun.ts, workerd.ts); this module only
// turns weights into a provider.

import type { FontEgress, FontProvider } from "@junejs/pdf-typst-wasm";
import type { AssetRef } from "./assets";

// The weights Markdown needs: body text, and bold for **strong** and headings.
export type NotoSansSCWeight = 400 | 700;

export type NotoSansSCOptions = {
  // Default [400, 700]. Only the listed weights are read and registered, so [400] halves the
  // font memory per renderer; Typst synthesizes bold from the regular. It doesn't shrink a
  // deploy: a Worker upload or a compiled binary carries both files either way.
  weights?: NotoSansSCWeight[];
};

export type WeightLoader = (weight: NotoSansSCWeight) => Promise<Uint8Array>;

// `egress`: what `load` contacts. The bundled entries read files the package ships: none.
export function createNotoSansSC(load: WeightLoader, opts: NotoSansSCOptions = {}, egress: FontEgress[] = []): FontProvider {
  const weights = [...new Set<NotoSansSCWeight>(opts.weights ?? [400, 700])];
  for (const w of weights) if (w !== 400 && w !== 700) throw new Error(`notoSansSC: no weight ${w as number} (this package ships 400 and 700)`);
  return {
    name: "noto-sans-sc",
    egress,
    persistent: () => Promise.all(weights.map(load)),
  };
}

// The upstream release the files come from: Noto Sans CJK's mainland China subset OTFs.
export const TAG = "Sans2.004";

const ref = (name: string, sha256: string, size: number): AssetRef => ({
  name,
  sha256,
  size,
  urls: [`https://raw.githubusercontent.com/notofonts/noto-cjk/${TAG}/Sans/SubsetOTF/SC/${name}`, `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${TAG}/Sans/SubsetOTF/SC/${name}`],
});

// Each weight's file, pinned: scripts/fetch-fonts.ts fetches and checks these, and the
// unbundled entry checks an app's loader against them (#383).
export const NOTO_SANS_SC: Record<NotoSansSCWeight, AssetRef> = {
  400: ref("NotoSansSC-Regular.otf", "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9", 8331336),
  700: ref("NotoSansSC-Bold.otf", "c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0", 8543168),
};

export const FILES: Record<NotoSansSCWeight, string> = { 400: NOTO_SANS_SC[400].name, 700: NOTO_SANS_SC[700].name };

export const MISSING = "@junejs/pdf-font-noto-sans-sc: its font files are missing — in the June repo, run `bun scripts/fetch-fonts.ts` in packages/pdf-font-noto-sans-sc";
