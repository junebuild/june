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

import type { FontEgress, FontProvider } from "@junejs/pdf-typst-wasm";
import type { AssetRef } from "@junejs/pdf-typst-wasm/unbundled";

// The weights Markdown needs: body text, and bold for **strong** and headings.
export type NotoSansTCWeight = 400 | 700;

export type NotoSansTCOptions = {
  // Default [400, 700]. Only the listed weights are read and registered, so [400] halves the
  // font memory per renderer; Typst synthesizes bold from the regular. It doesn't shrink a
  // deploy: a Worker upload or a compiled binary carries both files either way.
  weights?: NotoSansTCWeight[];
};

export type WeightLoader = (weight: NotoSansTCWeight) => Promise<Uint8Array>;

// `egress`: what `load` contacts. The bundled entries read files the package ships: none.
export function createNotoSansTC(load: WeightLoader, opts: NotoSansTCOptions = {}, egress: FontEgress[] = []): FontProvider {
  const weights = [...new Set<NotoSansTCWeight>(opts.weights ?? [400, 700])];
  for (const w of weights) if (w !== 400 && w !== 700) throw new Error(`notoSansTC: no weight ${w as number} (this package ships 400 and 700)`);
  return {
    name: "noto-sans-tc",
    egress,
    persistent: () => Promise.all(weights.map(load)),
  };
}

// The upstream release the files come from: Noto Sans CJK's Taiwan subset OTFs.
export const TAG = "Sans2.004";

const ref = (name: string, sha256: string, size: number): AssetRef => ({
  name,
  sha256,
  size,
  urls: [`https://raw.githubusercontent.com/notofonts/noto-cjk/${TAG}/Sans/SubsetOTF/TC/${name}`, `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${TAG}/Sans/SubsetOTF/TC/${name}`],
});

// Each weight's file, pinned: scripts/fetch-fonts.ts fetches and checks these, and the
// unbundled entry checks an app's loader against them (#383).
export const NOTO_SANS_TC: Record<NotoSansTCWeight, AssetRef> = {
  400: ref("NotoSansTC-Regular.otf", "5bab0cb3c1cf89dde07c4a95a4054b195afbcfe784d69d75c340780712237537", 5683368),
  700: ref("NotoSansTC-Bold.otf", "55420b259eb119bf5f2a0aadba10cf9d736c12d64ab93e78546d69ef5f43558b", 5839972),
};

export const FILES: Record<NotoSansTCWeight, string> = { 400: NOTO_SANS_TC[400].name, 700: NOTO_SANS_TC[700].name };

export const MISSING = "@junejs/pdf-font-noto-sans-tc: its font files are missing — in the June repo, run `bun scripts/fetch-fonts.ts` in packages/pdf-font-noto-sans-tc";
