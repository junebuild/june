// notoSansTC — a FontProvider (@junejs/pdf-typst-wasm) for Traditional Chinese that needs no
// network: Noto Sans CJK's Taiwan subset, regular and bold, shipped in this package (#371).
// The offline alternative to googleFontSubsets, which sends each document's characters to
// Google: here egress is empty and the cost is size instead, ~5.5 MB per weight, registered
// once per renderer.
//
// The subset is not every CJK ideograph. Measured with fontTools: 20,745 code points, 17,755
// of them Han, and every Big5 character except four symbols (U+02CD, U+203E, U+223C, U+2252).
// A rare character outside it (靐) is reported by the renderer's missing glyphs check like any
// other.
//
// Each runtime finds the files its own way (node.ts, bun.ts, workerd.ts); this module only
// turns weights into a provider.

import type { FontProvider } from "@junejs/pdf-typst-wasm";

// The weights Markdown needs: body text, and bold for **strong** and headings.
export type NotoSansTCWeight = 400 | 700;

export type NotoSansTCOptions = {
  // Default [400, 700]. A weight that isn't loaded is synthesized from another by Typst, so
  // [400] halves the size at the cost of faux bold.
  weights?: NotoSansTCWeight[];
};

export type WeightLoader = (weight: NotoSansTCWeight) => Promise<Uint8Array>;

export function createNotoSansTC(load: WeightLoader, opts: NotoSansTCOptions = {}): FontProvider {
  const weights = [...new Set<NotoSansTCWeight>(opts.weights ?? [400, 700])];
  for (const w of weights) if (w !== 400 && w !== 700) throw new Error(`notoSansTC: no weight ${w as number} (this package ships 400 and 700)`);
  return {
    name: "noto-sans-tc",
    egress: [],
    persistent: () => Promise.all(weights.map(load)),
  };
}

export const FILES: Record<NotoSansTCWeight, string> = { 400: "NotoSansTC-Regular.otf", 700: "NotoSansTC-Bold.otf" };

export const MISSING = "@junejs/pdf-font-noto-sans-tc: its font files are missing — in the June repo, run `bun scripts/fetch-fonts.ts` in packages/pdf-font-noto-sans-tc";
