// notoSansKR — a FontProvider (@junejs/pdf-typst-wasm) for Korean that needs no
// network: Noto Sans CJK's Korea subset, regular and bold, shipped in this package (#371).
// The offline alternative to googleFontSubsets, which sends each document's characters to
// Google: here egress is empty and the cost is size instead, ~4.5 MiB per weight, registered
// once per renderer.
//
// Measured with fontTools: 23,174 code points, among them all 11,172 Hangul syllables and
// 8,653 Han; with Typst's embedded fonts, every KS X 1001 character except three hanja
// (U+9699 and the compatibility ideographs U+F95F, U+F9AA).
// A rare character outside it (隙) is reported by the renderer's missing glyphs check
// like any other.
//
// Each runtime finds the files its own way (node.ts, bun.ts, workerd.ts); this module only
// turns weights into a provider.

import type { FontEgress, FontProvider } from "@junejs/pdf-typst-wasm";
import type { AssetRef } from "./assets";

// The weights Markdown needs: body text, and bold for **strong** and headings.
export type NotoSansKRWeight = 400 | 700;

export type NotoSansKROptions = {
  // Default [400, 700]. Only the listed weights are read and registered, so [400] halves the
  // font memory per renderer; Typst synthesizes bold from the regular. It doesn't shrink a
  // deploy: a Worker upload or a compiled binary carries both files either way.
  weights?: NotoSansKRWeight[];
};

export type WeightLoader = (weight: NotoSansKRWeight) => Promise<Uint8Array>;

// `egress`: what `load` contacts. The bundled entries read files the package ships: none.
export function createNotoSansKR(load: WeightLoader, opts: NotoSansKROptions = {}, egress: FontEgress[] = []): FontProvider {
  const weights = [...new Set<NotoSansKRWeight>(opts.weights ?? [400, 700])];
  for (const w of weights) if (w !== 400 && w !== 700) throw new Error(`notoSansKR: no weight ${w as number} (this package ships 400 and 700)`);
  return {
    name: "noto-sans-kr",
    egress,
    persistent: () => Promise.all(weights.map(load)),
  };
}

// The upstream release the files come from: Noto Sans CJK's Korea subset OTFs.
export const TAG = "Sans2.004";

const ref = (name: string, sha256: string, size: number): AssetRef => ({
  name,
  sha256,
  size,
  urls: [`https://raw.githubusercontent.com/notofonts/noto-cjk/${TAG}/Sans/SubsetOTF/KR/${name}`, `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${TAG}/Sans/SubsetOTF/KR/${name}`],
});

// Each weight's file, pinned: scripts/fetch-fonts.ts fetches and checks these, and the
// unbundled entry checks an app's loader against them (#383).
export const NOTO_SANS_KR: Record<NotoSansKRWeight, AssetRef> = {
  400: ref("NotoSansKR-Regular.otf", "69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68", 4644748),
  700: ref("NotoSansKR-Bold.otf", "5a6ceb287ed2fc6cfc6213144ebea68cbd94b20fc9eb873d8486493bf02d9bda", 4816044),
};

export const FILES: Record<NotoSansKRWeight, string> = { 400: NOTO_SANS_KR[400].name, 700: NOTO_SANS_KR[700].name };

export const MISSING = "@junejs/pdf-font-noto-sans-kr: its font files are missing — in the June repo, run `bun scripts/fetch-fonts.ts` in packages/pdf-font-noto-sans-kr";
