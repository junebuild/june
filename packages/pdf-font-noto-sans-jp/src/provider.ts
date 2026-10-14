// notoSansJP — a FontProvider (@junejs/pdf-typst-wasm) for Japanese that needs no
// network: Noto Sans CJK's Japan subset, regular and bold, shipped in this package (#371).
// The offline alternative to googleFontSubsets, which sends each document's characters to
// Google: here egress is empty and the cost is size instead, ~4.4 MiB per weight, registered
// once per renderer.
//
// The subset is not every CJK ideograph. Measured with fontTools: 16,732 code points, 13,742
// of them Han; with Typst's embedded fonts, every JIS X 0213 character (the subset alone lacks
// 162 of them, none Han, all covered by the embedded fonts).
// A rare character outside it (靐) is reported by the renderer's missing glyphs check
// like any other.
//
// Each runtime finds the files its own way (node.ts, bun.ts, workerd.ts); this module only
// turns weights into a provider.

import type { FontEgress, FontProvider } from "@junejs/pdf-typst-wasm";
import type { AssetRef } from "./assets";

// The weights Markdown needs: body text, and bold for **strong** and headings.
export type NotoSansJPWeight = 400 | 700;

export type NotoSansJPOptions = {
  // Default [400, 700]. Only the listed weights are read and registered, so [400] halves the
  // font memory per renderer; Typst synthesizes bold from the regular. It doesn't shrink a
  // deploy: a Worker upload or a compiled binary carries both files either way.
  weights?: NotoSansJPWeight[];
};

export type WeightLoader = (weight: NotoSansJPWeight) => Promise<Uint8Array>;

// `egress`: what `load` contacts. The bundled entries read files the package ships: none.
export function createNotoSansJP(load: WeightLoader, opts: NotoSansJPOptions = {}, egress: FontEgress[] = []): FontProvider {
  const weights = [...new Set<NotoSansJPWeight>(opts.weights ?? [400, 700])];
  for (const w of weights) if (w !== 400 && w !== 700) throw new Error(`notoSansJP: no weight ${w as number} (this package ships 400 and 700)`);
  return {
    name: "noto-sans-jp",
    egress,
    persistent: () => Promise.all(weights.map(load)),
  };
}

// The upstream release the files come from: Noto Sans CJK's Japan subset OTFs.
export const TAG = "Sans2.004";

const ref = (name: string, sha256: string, size: number): AssetRef => ({
  name,
  sha256,
  size,
  urls: [`https://raw.githubusercontent.com/notofonts/noto-cjk/${TAG}/Sans/SubsetOTF/JP/${name}`, `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${TAG}/Sans/SubsetOTF/JP/${name}`],
});

// Each weight's file, pinned: scripts/fetch-fonts.ts fetches and checks these, and the
// unbundled entry checks an app's loader against them (#383).
export const NOTO_SANS_JP: Record<NotoSansJPWeight, AssetRef> = {
  400: ref("NotoSansJP-Regular.otf", "dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073", 4533028),
  700: ref("NotoSansJP-Bold.otf", "1b0edfb500b73a4fa8a4fcaae1bbbd403994e08e73e3e0da37e70d3853f42c5f", 4656448),
};

export const FILES: Record<NotoSansJPWeight, string> = { 400: NOTO_SANS_JP[400].name, 700: NOTO_SANS_JP[700].name };

export const MISSING = "@junejs/pdf-font-noto-sans-jp: its font files are missing — in the June repo, run `bun scripts/fetch-fonts.ts` in packages/pdf-font-noto-sans-jp";
