// typstWasmRenderer against the built engine (dist/typst.wasm). Google Fonts goes through a
// stubbed fetch, so the suite makes no network call; the stub serves a Latin font file, which
// is enough to prove the plumbing — which characters are asked for, that subsets are cached
// and scoped to one document. Skipped, with the command to run, when the module isn't built.

import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { memoryFileStore } from "@junejs/core/agent-files";
import type { ToolContext } from "@junejs/core/agent-runtime";
import { pdfTools } from "@junejs/pdf";
import { createEngine, TypstCompileError, typstWasmRenderer, WASM_URL } from "@junejs/pdf-typst-wasm";

const built = existsSync(fileURLToPath(WASM_URL));
if (!built) console.warn("[pdf-typst-wasm] dist/typst.wasm is missing — run `bun run build:wasm` in packages/pdf-typst-wasm to run these tests");

const latinFont = new Uint8Array(await readFile(new URL("../../june/assets/icon-latin.ttf", import.meta.url)));
const latin1 = new TextDecoder("latin1");
const pages = (pdf: Uint8Array) => Number(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(latin1.decode(pdf))?.[1] ?? NaN);
const fonts = (pdf: Uint8Array) => [...new Set([...latin1.decode(pdf).matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]!))];

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
    const r = typstWasmRenderer({ fetch: fetcher });
    await r.render({ markdown: "# 營收週報\n\nRevenue 成長 12%。" });
    const css = calls.filter((c) => c.url.startsWith("https://fonts.googleapis.com/css2"));
    expect(css.map((c) => new URL(c.url).searchParams.get("family"))).toEqual(["Noto Sans TC:wght@400", "Noto Sans TC:wght@700"]);
    expect(new URL(css[0]!.url).searchParams.get("text")).toBe("營收週報成長。");
    expect(css[0]!.userAgent).toContain("Safari/533"); // old Safari → TTF, which Typst reads
    const before = calls.length;
    await r.render({ markdown: "# 營收週報\n\nRevenue 成長 12%。" }); // same characters: served from the cache
    expect(calls.length).toBe(before);
  });

  test("an ASCII document fetches nothing; googleFonts: false never fetches", async () => {
    const { calls, fetcher } = googleStub();
    await typstWasmRenderer({ fetch: fetcher }).render({ markdown: "# Plain ASCII" });
    await typstWasmRenderer({ fetch: fetcher, googleFonts: false }).render({ markdown: "# 中文" });
    expect(calls).toEqual([]);
  });

  test("a font that can't be fetched costs glyphs, not the document", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
      const pdf = await typstWasmRenderer({ fetch: failing, googleFonts: [{ family: "Noto Sans JP" }] }).render({ markdown: "# 日本語のテキスト" });
      expect(pages(pdf)).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("Noto Sans JP 400");
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
});

describe.skipIf(!built)("createEngine", () => {
  test("a Typst error is a TypstCompileError with the diagnostic, and the engine keeps working", async () => {
    const engine = await createEngine(await readFile(WASM_URL));
    expect(() => engine.compile("#let x = (")).toThrow(TypstCompileError);
    expect(() => engine.compile('#read("/etc/passwd")')).toThrow(/denied/);
    expect(latin1.decode(engine.compile("ok").slice(0, 5))).toBe("%PDF-");
  });

});
