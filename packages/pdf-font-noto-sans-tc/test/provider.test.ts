// notoSansTC with the real engine and the real font files. Skipped, with the commands to run,
// when either is missing: the files come from scripts/fetch-fonts.ts, the engine from
// `bun run build:wasm` in packages/pdf-typst-wasm.

import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PdfRenderError } from "@junejs/pdf";
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
import { typstWasmRenderer, WASM_URL } from "@junejs/pdf-typst-wasm";

const fonts = existsSync(fileURLToPath(new URL("../fonts/NotoSansTC-Regular.otf", import.meta.url)));
const engine = existsSync(fileURLToPath(WASM_URL));
if (!fonts) console.warn("[pdf-font-noto-sans-tc] fonts/ is empty — run `bun scripts/fetch-fonts.ts` in packages/pdf-font-noto-sans-tc to run these tests");
if (!engine) console.warn("[pdf-font-noto-sans-tc] the engine isn't built — run `bun run build:wasm` in packages/pdf-typst-wasm to run these tests");

const latin1 = new TextDecoder("latin1");
const embedded = (pdf: Uint8Array) => [...new Set([...latin1.decode(pdf).matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]!))];

test("declares no egress, and only ships 400 and 700", () => {
  expect(notoSansTC().egress).toEqual([]);
  expect(typstWasmRenderer({ fonts: [notoSansTC()] }).egress).toEqual([]);
  expect(() => notoSansTC({ weights: [300 as 400] })).toThrow("no weight 300");
});

describe.skipIf(!fonts || !engine)("notoSansTC on the engine", () => {
  test("Traditional Chinese renders offline, regular and bold embedded", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const pdf = await typstWasmRenderer({ fonts: [notoSansTC()] }).render({ markdown: "# 季度報告\n\n**營收**成長 12%。臺灣、裏、峯、齉龘爩鬱。", lang: "zh-TW" });
      expect(embedded(pdf)).toEqual(expect.arrayContaining(["NotoSansTC-Regular", "NotoSansTC-Bold"]));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("weights: [400] loads only the regular", async () => {
    const pdf = await typstWasmRenderer({ fonts: [notoSansTC({ weights: [400] })] }).render({ markdown: "# 標題\n\n內文。" });
    const names = embedded(pdf).filter((f) => f.startsWith("NotoSansTC"));
    expect(names.every((f) => f.startsWith("NotoSansTC-Regular"))).toBe(true);
  });

  test("a character outside the subset is still a missing glyphs error", async () => {
    const err = await typstWasmRenderer({ fonts: [notoSansTC()] }).render({ markdown: "雷聲：靐" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as Error).message).toContain("covers 靐,");
  });
});
