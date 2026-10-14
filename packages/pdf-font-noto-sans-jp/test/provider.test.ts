// notoSansJP with the real engine and the real font files. Skipped, with the commands to run,
// when either is missing: the files come from scripts/fetch-fonts.ts, the engine from
// `bun run build:wasm` in packages/pdf-typst-wasm.

import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PdfRenderError } from "@junejs/pdf";
import { notoSansJP } from "@junejs/pdf-font-noto-sans-jp";
import { NOTO_SANS_JP, notoSansJP as unbundledNotoSansJP } from "@junejs/pdf-font-noto-sans-jp/unbundled";
import { readFile } from "node:fs/promises";
import { typstWasmRenderer, WASM_URL } from "@junejs/pdf-typst-wasm";

const fonts = existsSync(fileURLToPath(new URL("../fonts/NotoSansJP-Regular.otf", import.meta.url)));
const engine = existsSync(fileURLToPath(WASM_URL));
if (!fonts) console.warn("[pdf-font-noto-sans-jp] fonts/ is empty — run `bun scripts/fetch-fonts.ts` in packages/pdf-font-noto-sans-jp to run these tests");
if (!engine) console.warn("[pdf-font-noto-sans-jp] the engine isn't built — run `bun run build:wasm` in packages/pdf-typst-wasm to run these tests");

const latin1 = new TextDecoder("latin1");
const embedded = (pdf: Uint8Array) => [...new Set([...latin1.decode(pdf).matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]!))];

test("declares no egress, and only ships 400 and 700", () => {
  expect(notoSansJP().egress).toEqual([]);
  expect(typstWasmRenderer({ fonts: [notoSansJP()] }).egress).toEqual([]);
  expect(() => notoSansJP({ weights: [300 as 400] })).toThrow("no weight 300");
});

describe.skipIf(!fonts || !engine)("notoSansJP on the engine", () => {
  test("Japanese renders offline, regular and bold embedded", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const pdf = await typstWasmRenderer({ fonts: [notoSansJP()] }).render({ markdown: "# 四半期報告\n\n**売上**は12%増加しました。ひらがな、カタカナ、漢字。", lang: "ja" });
      expect(embedded(pdf)).toEqual(expect.arrayContaining(["NotoSansJP-Regular", "NotoSansJP-Bold"]));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("weights: [400] loads only the regular", async () => {
    const pdf = await typstWasmRenderer({ fonts: [notoSansJP({ weights: [400] })] }).render({ markdown: "# 見出し\n\n本文。" });
    const names = embedded(pdf).filter((f) => f.startsWith("NotoSansJP"));
    expect(names.every((f) => f.startsWith("NotoSansJP-Regular"))).toBe(true);
  });

  test("a character outside the subset is still a missing glyphs error", async () => {
    const err = await typstWasmRenderer({ fonts: [notoSansJP()] }).render({ markdown: "難読：靐" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as Error).message).toContain("covers 靐,");
  });
});

describe("notoSansJP (unbundled)", () => {
  test("declares the files' hosts until told they are pre-seeded", () => {
    const load = async () => new Uint8Array();
    expect(unbundledNotoSansJP({ load }).egress).toEqual([
      { host: "raw.githubusercontent.com", sends: "nothing" },
      { host: "cdn.jsdelivr.net", sends: "nothing" },
    ]);
    expect(unbundledNotoSansJP({ load, egress: [] }).egress).toEqual([]);
  });

  test("needs nothing from @junejs/pdf-typst-wasm's unbundled entry, which 0.2.0 doesn't have", async () => {
    const { readFile: read } = await import("node:fs/promises");
    for (const f of ["provider.ts", "unbundled.ts", "assets.ts"]) expect(await read(new URL(`../src/${f}`, import.meta.url), "utf8")).not.toMatch(/from "@junejs\/pdf-typst-wasm\/unbundled"/);
  });

  test("a file that doesn't match its pinned ref is never registered", async () => {
    await expect(unbundledNotoSansJP({ load: async () => new Uint8Array(10), weights: [400] }).persistent!()).rejects.toThrow(/NotoSansJP-Regular\.otf: the loader returned 10 bytes/);
  });

  describe.skipIf(!fonts || !engine)("with the files and the engine", () => {
    test("the pinned refs describe the files this package ships", async () => {
      for (const ref of Object.values(NOTO_SANS_JP)) {
        const bytes = new Uint8Array(await readFile(new URL(`../fonts/${ref.name}`, import.meta.url)));
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
        expect({ size: bytes.length, sha256: digest }).toEqual({ size: ref.size, sha256: ref.sha256 });
      }
    });

    test("loads only the weights asked for, through the app's loader, and renders", async () => {
      const asked: string[] = [];
      const load = async (ref: { name: string }) => (asked.push(ref.name), readFile(new URL(`../fonts/${ref.name}`, import.meta.url)));
      const pdf = await typstWasmRenderer({ fonts: [unbundledNotoSansJP({ load, weights: [400] })] }).render({ markdown: "日本語" });
      expect(asked).toEqual(["NotoSansJP-Regular.otf"]);
      expect(embedded(pdf)).toEqual(expect.arrayContaining(["NotoSansJP-Regular"]));
    });
  });
});

