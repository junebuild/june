// typstWasmRenderer against the built engine (dist/typst.wasm). Google Fonts goes through a
// stubbed fetch, so the suite makes no network call; the stub serves a Latin font file, which
// is enough to prove the plumbing — which characters are asked for, that subsets are cached
// and scoped to one document. A Latin font leaves CJK uncovered, so those tests accept the
// gaps (`onMissingGlyphs: "warn"`, logged quietly); the missing glyphs tests make the same
// gaps an error. Skipped, with the command to run, when the module isn't built.

import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { memoryFileStore } from "@junejs/core/agent-files";
import type { ToolContext } from "@junejs/core/agent-runtime";
import { PdfRenderError, pdfTools } from "@junejs/pdf";
import { createEngine, TypstCompileError, typstWasmRenderer, WASM_URL } from "@junejs/pdf-typst-wasm";

const built = existsSync(fileURLToPath(WASM_URL));
if (!built) console.warn("[pdf-typst-wasm] dist/typst.wasm is missing — run `bun run build:wasm` in packages/pdf-typst-wasm to run these tests");

const latinFont = new Uint8Array(await readFile(new URL("../../june/assets/icon-latin.ttf", import.meta.url)));
const latin1 = new TextDecoder("latin1");
const pages = (pdf: Uint8Array) => Number(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(latin1.decode(pdf))?.[1] ?? NaN);
const fonts = (pdf: Uint8Array) => [...new Set([...latin1.decode(pdf).matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]!))];

// The stand-in font lacks CJK glyphs: accept the gaps, and keep their warning out of the output.
const ACCEPT_GAPS = { onMissingGlyphs: "warn" } as const;
async function quietly<T>(f: () => Promise<T>): Promise<T> {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    return await f();
  } finally {
    warn.mockRestore();
  }
}

// A Google Fonts stand-in: the CSS names a font URL; the font URL serves `latinFont`.
function googleStub() {
  const calls: { url: string; userAgent?: string }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") ?? undefined });
    if (url.startsWith("https://fonts.googleapis.com/css2")) return new Response(`@font-face { src: url(https://fonts.gstatic.test/${calls.length}.ttf) format('truetype'); }`);
    if (url.startsWith("https://fonts.gstatic.test/")) return new Response(latinFont);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher };
}


describe.skipIf(!built)("typstWasmRenderer", () => {
  test("Markdown to PDF with the embedded fonts alone", async () => {
    const r = typstWasmRenderer({ googleFonts: false });
    expect(r.name).toBe("typst-wasm");
    const pdf = await r.render({ title: "Weekly revenue", markdown: "# Weekly revenue\n\nRevenue grew **12%** — `revenue.sql`.\n\n| a | b |\n|--|--:|\n| 1 | 2 |" });
    expect(latin1.decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pages(pdf)).toBe(1);
    expect(fonts(pdf)).toEqual(expect.arrayContaining([expect.stringMatching(/^LibertinusSerif/), expect.stringMatching(/^DejaVuSansMono/)]));
  });

  test("one engine for every render: the module loads once", async () => {
    let loads = 0;
    const bytes = await readFile(WASM_URL);
    const r = typstWasmRenderer({ googleFonts: false, wasm: async () => { loads++; return bytes; } });
    await Promise.all([r.render({ markdown: "# A" }), r.render({ markdown: "# B" })]);
    await r.render({ markdown: "# C" });
    expect(loads).toBe(1);
  });

  test("concurrent renders each get their own document", async () => {
    const r = typstWasmRenderer({ googleFonts: false });
    const long = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}.`).join("\n\n");
    const [a, b] = await Promise.all([r.render({ markdown: "# Short" }), r.render({ markdown: long })]);
    expect(pages(a)).toBe(1);
    expect(pages(b)).toBeGreaterThan(2);
  });

  test("non-ASCII text fetches a Google Fonts subset for exactly its characters, cached", async () => {
    const { calls, fetcher } = googleStub();
    const r = typstWasmRenderer({ fetch: fetcher, ...ACCEPT_GAPS });
    await quietly(() => r.render({ markdown: "# 營收週報\n\nRevenue 成長 12%。" }));
    const css = calls.filter((c) => c.url.startsWith("https://fonts.googleapis.com/css2"));
    expect(css.map((c) => new URL(c.url).searchParams.get("family"))).toEqual(["Noto Sans TC:wght@400", "Noto Sans TC:wght@700"]);
    expect(new URL(css[0]!.url).searchParams.get("text")).toBe("營收週報成長。");
    expect(css[0]!.userAgent).toContain("Safari/533"); // old Safari → TTF, which Typst reads
    const before = calls.length;
    await quietly(() => r.render({ markdown: "# 營收週報\n\nRevenue 成長 12%。" })); // same characters: served from the cache
    expect(calls.length).toBe(before);
  });

  test("renderers don't share subsets: each fetches through its own fetch", async () => {
    const a = googleStub();
    const b = googleStub();
    const doc = { markdown: "# 共用快取" };
    await quietly(() => typstWasmRenderer({ fetch: a.fetcher, ...ACCEPT_GAPS }).render(doc));
    await quietly(() => typstWasmRenderer({ fetch: b.fetcher, ...ACCEPT_GAPS }).render(doc));
    expect(a.calls.length).toBeGreaterThan(0);
    expect(b.calls.length).toBe(a.calls.length); // b fetched for itself, not served from a's cache
  });

  test("an ASCII document fetches nothing; googleFonts: false never fetches", async () => {
    const { calls, fetcher } = googleStub();
    await typstWasmRenderer({ fetch: fetcher }).render({ markdown: "# Plain ASCII" });
    await quietly(() => typstWasmRenderer({ fetch: fetcher, googleFonts: false, ...ACCEPT_GAPS }).render({ markdown: "# 中文" }));
    expect(calls).toEqual([]);
  });

  test("characters no font covers are a PdfRenderError naming them, not a PDF with blanks", async () => {
    const r = typstWasmRenderer({ googleFonts: false });
    const err = await r.render({ markdown: "# 報告 Report\n\nHello from Scout. 中文測試。" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as Error).message).toContain("covers 報 告 中 文 測 試 。,");
    expect((err as Error).message).toContain("`fonts` or `googleFonts`");
    // Many characters: the first ten, then a count.
    const many = await r.render({ markdown: "一二三四五六七八九十百千萬" }).catch((e: unknown) => e);
    expect((many as Error).message).toContain("covers 一 二 三 四 五 六 七 八 九 十 (and 3 more),");
  });

  test("covered non-ASCII text and invisible characters render without complaint", async () => {
    const pdf = await typstWasmRenderer({ googleFonts: false }).render({ markdown: "# Café — “Ελληνικά”, Русский\u200B\uFE0F" });
    expect(pages(pdf)).toBe(1);
  });

  test("a font that can't be fetched, leaving characters uncovered, is an error that says why", async () => {
    const failing = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const err = await typstWasmRenderer({ fetch: failing, googleFonts: [{ family: "Noto Sans JP" }] }).render({ markdown: "# 日本語のテキスト" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as Error).message).toContain("covers 日 本 語");
    expect((err as Error).message).toContain("Noto Sans JP 400 could not be fetched from Google Fonts (Google Fonts CSS: HTTP 503)");
  });

  test('onMissingGlyphs: "warn" returns the PDF and logs the characters', async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pdf = await typstWasmRenderer({ googleFonts: false, onMissingGlyphs: "warn" }).render({ markdown: "# Done 😀" });
      expect(pages(pdf)).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("covers 😀,");
    } finally {
      warn.mockRestore();
    }
  });

  test("app fonts register once and serve every document", async () => {
    const r = typstWasmRenderer({ googleFonts: false, fonts: [latinFont], fontFamilies: ["Inter"] });
    for (const markdown of ["# One", "# Two"]) expect(fonts(await r.render({ markdown }))).toEqual(expect.arrayContaining([expect.stringMatching(/^Inter/)]));
  });

  test("render_pdf on this renderer stores the PDF and returns the ref", async () => {
    const [tool] = pdfTools({ renderer: typstWasmRenderer({ googleFonts: false }) });
    const files = memoryFileStore();
    const out = (await tool!.run({ markdown: "# Q3 report\n\nAll good.", filename: "q3.pdf" }, { files } as unknown as ToolContext)) as { file: { id: string; name: string } };
    expect(out.file.name).toBe("q3.pdf");
    expect(latin1.decode((await files.get(out.file.id))!.slice(0, 5))).toBe("%PDF-");
  });

  test("render_pdf fails with the missing glyphs error, so the model sees it", async () => {
    const [tool] = pdfTools({ renderer: typstWasmRenderer({ googleFonts: false }) });
    const files = memoryFileStore();
    await expect(tool!.run({ markdown: "# 季報" }, { files } as unknown as ToolContext)).rejects.toThrow(/covers 季 報/);
  });
});

describe.skipIf(!built)("createEngine", () => {
  test("a Typst error is a TypstCompileError with the diagnostic, and the engine keeps working", async () => {
    const engine = await createEngine(await readFile(WASM_URL));
    expect(() => engine.compile("#let x = (")).toThrow(TypstCompileError);
    expect(() => engine.compile('#read("/etc/passwd")')).toThrow(/denied/);
    const ok = engine.compile("ok");
    expect(latin1.decode(ok.pdf.slice(0, 5))).toBe("%PDF-");
    expect(ok.missingGlyphs).toEqual([]);
  });

  test("characters no font covers come back with the PDF, each once, emoji whole", async () => {
    const engine = await createEngine(await readFile(WASM_URL));
    const out = engine.compile("報告 Report 報 😀");
    expect(latin1.decode(out.pdf.slice(0, 5))).toBe("%PDF-");
    expect(out.missingGlyphs).toEqual(["報", "告", "😀"]);
  });

});
