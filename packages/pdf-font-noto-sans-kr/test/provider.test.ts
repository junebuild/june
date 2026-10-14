// notoSansKR with the real engine and the real font files. Skipped, with the commands to run,
// when either is missing: the files come from scripts/fetch-fonts.ts, the engine from
// `bun run build:wasm` in packages/pdf-typst-wasm.

import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PdfRenderError } from "@junejs/pdf";
import { notoSansKR } from "@junejs/pdf-font-noto-sans-kr";
import { NOTO_SANS_KR, notoSansKR as unbundledNotoSansKR } from "@junejs/pdf-font-noto-sans-kr/unbundled";
import { readFile } from "node:fs/promises";
import { typstWasmRenderer, WASM_URL } from "@junejs/pdf-typst-wasm";

const fonts = existsSync(fileURLToPath(new URL("../fonts/NotoSansKR-Regular.otf", import.meta.url)));
const engine = existsSync(fileURLToPath(WASM_URL));
if (!fonts) console.warn("[pdf-font-noto-sans-kr] fonts/ is empty — run `bun scripts/fetch-fonts.ts` in packages/pdf-font-noto-sans-kr to run these tests");
if (!engine) console.warn("[pdf-font-noto-sans-kr] the engine isn't built — run `bun run build:wasm` in packages/pdf-typst-wasm to run these tests");

const latin1 = new TextDecoder("latin1");
const embedded = (pdf: Uint8Array) => [...new Set([...latin1.decode(pdf).matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]!))];

test("declares no egress, and only ships 400 and 700", () => {
  expect(notoSansKR().egress).toEqual([]);
  expect(typstWasmRenderer({ fonts: [notoSansKR()] }).egress).toEqual([]);
  expect(() => notoSansKR({ weights: [300 as 400] })).toThrow("no weight 300");
});

describe.skipIf(!fonts || !engine)("notoSansKR on the engine", () => {
  test("Korean renders offline, regular and bold embedded", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const pdf = await typstWasmRenderer({ fonts: [notoSansKR()] }).render({ markdown: "# 분기 보고서\n\n**매출**이 12% 증가했습니다. 한글과 漢字.", lang: "ko" });
      expect(embedded(pdf)).toEqual(expect.arrayContaining(["NotoSansKR-Regular", "NotoSansKR-Bold"]));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("weights: [400] loads only the regular", async () => {
    const pdf = await typstWasmRenderer({ fonts: [notoSansKR({ weights: [400] })] }).render({ markdown: "# 제목\n\n본문." });
    const names = embedded(pdf).filter((f) => f.startsWith("NotoSansKR"));
    expect(names.every((f) => f.startsWith("NotoSansKR-Regular"))).toBe(true);
  });

  test("a character outside the subset is still a missing glyphs error", async () => {
    const err = await typstWasmRenderer({ fonts: [notoSansKR()] }).render({ markdown: "틈: 隙" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as Error).message).toContain("covers 隙,");
  });
});

describe("notoSansKR (unbundled)", () => {
  test("declares the files' hosts until told they are pre-seeded", () => {
    const load = async () => new Uint8Array();
    expect(unbundledNotoSansKR({ load }).egress).toEqual([
      { host: "raw.githubusercontent.com", sends: "nothing" },
      { host: "cdn.jsdelivr.net", sends: "nothing" },
    ]);
    expect(unbundledNotoSansKR({ load, egress: [] }).egress).toEqual([]);
  });

  test("needs nothing from @junejs/pdf-typst-wasm's unbundled entry, which 0.2.0 doesn't have", async () => {
    const { readFile: read } = await import("node:fs/promises");
    for (const f of ["provider.ts", "unbundled.ts", "assets.ts"]) expect(await read(new URL(`../src/${f}`, import.meta.url), "utf8")).not.toMatch(/from "@junejs\/pdf-typst-wasm\/unbundled"/);
  });

  test("a file that doesn't match its pinned ref is never registered", async () => {
    await expect(unbundledNotoSansKR({ load: async () => new Uint8Array(10), weights: [400] }).persistent!()).rejects.toThrow(/NotoSansKR-Regular\.otf: the loader returned 10 bytes/);
  });

  describe.skipIf(!fonts || !engine)("with the files and the engine", () => {
    test("the pinned refs describe the files this package ships", async () => {
      for (const ref of Object.values(NOTO_SANS_KR)) {
        const bytes = new Uint8Array(await readFile(new URL(`../fonts/${ref.name}`, import.meta.url)));
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
        expect({ size: bytes.length, sha256: digest }).toEqual({ size: ref.size, sha256: ref.sha256 });
      }
    });

    test("loads only the weights asked for, through the app's loader, and renders", async () => {
      const asked: string[] = [];
      const load = async (ref: { name: string }) => (asked.push(ref.name), readFile(new URL(`../fonts/${ref.name}`, import.meta.url)));
      const pdf = await typstWasmRenderer({ fonts: [unbundledNotoSansKR({ load, weights: [400] })] }).render({ markdown: "한국어" });
      expect(asked).toEqual(["NotoSansKR-Regular.otf"]);
      expect(embedded(pdf)).toEqual(expect.arrayContaining(["NotoSansKR-Regular"]));
    });
  });
});

