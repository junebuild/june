// typstWasmRenderer against the built engine (dist/typst.wasm). Font providers fetch through a
// stub, so the suite makes no network call; the stub serves a Latin font file, which
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
import { createEngine, googleFontSubsets, localFonts, TypstCompileError, typstWasmRenderer, WASM_URL } from "@junejs/pdf-typst-wasm";

const built = existsSync(fileURLToPath(WASM_URL));
if (!built) console.warn("[pdf-typst-wasm] dist/typst.wasm is missing — run `bun run build:wasm` in packages/pdf-typst-wasm to run these tests");

const latinFont = new Uint8Array(await readFile(new URL("../../june/assets/icon-latin.ttf", import.meta.url)));
const latin1 = new TextDecoder("latin1");
const pages = (pdf: Uint8Array) => Number(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(latin1.decode(pdf))?.[1] ?? NaN);
const fonts = (pdf: Uint8Array) => [...new Set([...latin1.decode(pdf).matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]!))];

const TC = { family: "Noto Sans TC", weights: [400, 700] };

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
  test("Markdown to PDF with the embedded fonts alone, offline by default", async () => {
    const r = typstWasmRenderer();
    expect(r.name).toBe("typst-wasm");
    expect(r.egress).toEqual([]);
    const markdown = [
      "# Weekly revenue",
      "",
      "Revenue grew **12%** to $48,200 — see [the dashboard](https://example.com/d?x=1&y=2).",
      "",
      "| Region | Revenue |",
      "|:--|--:|",
      "| North | 21,000 |",
      "",
      "- email ops@example.com",
      "- `#hashtag` and // slashes",
      "",
      "```ts",
      'const total = 21_000 + 27_200; // "48,200"',
      "```",
    ].join("\n");
    const pdf = await r.render({ title: "Weekly revenue", markdown });
    expect(latin1.decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pages(pdf)).toBe(1);
    expect(fonts(pdf)).toEqual(expect.arrayContaining([expect.stringMatching(/^LibertinusSerif/), expect.stringMatching(/^DejaVuSansMono/)]));
  });

  test("the default makes no network call, even for text it can't cover", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      await quietly(() => typstWasmRenderer(ACCEPT_GAPS).render({ markdown: "# 中文 😀" }));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("one engine for every render: the module loads once", async () => {
    let loads = 0;
    const bytes = await readFile(WASM_URL);
    const r = typstWasmRenderer({ wasm: async () => { loads++; return bytes; } });
    await Promise.all([r.render({ markdown: "# A" }), r.render({ markdown: "# B" })]);
    await r.render({ markdown: "# C" });
    expect(loads).toBe(1);
  });

  test("concurrent renders each get their own document", async () => {
    const r = typstWasmRenderer();
    const long = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}.`).join("\n\n");
    const [a, b] = await Promise.all([r.render({ markdown: "# Short" }), r.render({ markdown: long })]);
    expect(pages(a)).toBe(1);
    expect(pages(b)).toBeGreaterThan(2);
  });

  test("egress is the union the providers declare, a host's strongest claim winning", () => {
    const r = typstWasmRenderer({
      fonts: [localFonts([latinFont, "https://fonts.gstatic.com/s/inter.ttf", "https://cdn.example/a.ttf"]), googleFontSubsets({ families: [TC] })],
    });
    expect(r.egress).toEqual([
      { host: "fonts.gstatic.com", sends: "document-characters" },
      { host: "cdn.example", sends: "nothing" },
      { host: "fonts.googleapis.com", sends: "document-characters" },
    ]);
    expect(localFonts([latinFont]).egress).toEqual([]);
  });

  test("the configuration is read once: arrays changed later don't change what renders or egress", async () => {
    const { calls, fetcher } = googleStub();
    const providers = [localFonts([latinFont])];
    const sources: (Uint8Array | string)[] = [latinFont];
    const local = localFonts(sources, { fetch: fetcher });
    const r = typstWasmRenderer({ fonts: providers, ...ACCEPT_GAPS });
    providers.push(googleFontSubsets({ families: [TC], fetch: fetcher }));
    sources.push("https://fonts.gstatic.test/late.ttf");
    expect(r.egress).toEqual([]);
    expect(local.egress).toEqual([]);
    await quietly(() => r.render({ markdown: "# 中文" }));
    await local.persistent!();
    expect(calls).toEqual([]);
  });

  test("googleFontSubsets fetches a subset for exactly the document's characters, cached", async () => {
    const { calls, fetcher } = googleStub();
    const r = typstWasmRenderer({ fonts: [googleFontSubsets({ families: [TC], fetch: fetcher })], ...ACCEPT_GAPS });
    await quietly(() => r.render({ markdown: "# 營收週報\n\nRevenue 成長 12%。" }));
    const css = calls.filter((c) => c.url.startsWith("https://fonts.googleapis.com/css2"));
    expect(css.map((c) => new URL(c.url).searchParams.get("family"))).toEqual(["Noto Sans TC:wght@400", "Noto Sans TC:wght@700"]);
    expect(new URL(css[0]!.url).searchParams.get("text")).toBe("營收週報成長。");
    expect(css[0]!.userAgent).toContain("Safari/533"); // old Safari → TTF, which Typst reads
    const before = calls.length;
    await quietly(() => r.render({ markdown: "# 營收週報\n\nRevenue 成長 12%。" })); // same characters: served from the cache
    expect(calls.length).toBe(before);
  });

  test("providers don't share subsets: each fetches through its own fetch", async () => {
    const a = googleStub();
    const b = googleStub();
    const doc = { markdown: "# 共用快取" };
    await quietly(() => typstWasmRenderer({ fonts: [googleFontSubsets({ families: [TC], fetch: a.fetcher })], ...ACCEPT_GAPS }).render(doc));
    await quietly(() => typstWasmRenderer({ fonts: [googleFontSubsets({ families: [TC], fetch: b.fetcher })], ...ACCEPT_GAPS }).render(doc));
    expect(a.calls.length).toBeGreaterThan(0);
    expect(b.calls.length).toBe(a.calls.length); // b fetched for itself, not served from a's cache
  });

  test("an ASCII document fetches no subset", async () => {
    const { calls, fetcher } = googleStub();
    await typstWasmRenderer({ fonts: [googleFontSubsets({ families: [TC], fetch: fetcher })] }).render({ markdown: "# Plain ASCII" });
    expect(calls).toEqual([]);
  });

  test("characters no font covers are a PdfRenderError naming them, not a PDF with blanks", async () => {
    const r = typstWasmRenderer();
    const err = await r.render({ markdown: "# 報告 Report\n\nHello from Scout. 中文測試。" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as Error).message).toContain("covers 報 告 中 文 測 試 。,");
    expect((err as Error).message).toContain("`fonts` (localFonts or googleFontSubsets)");
    // Many characters: the first ten, then a count.
    const many = await r.render({ markdown: "一二三四五六七八九十百千萬" }).catch((e: unknown) => e);
    expect((many as Error).message).toContain("covers 一 二 三 四 五 六 七 八 九 十 (and 3 more),");
  });

  test("covered non-ASCII text and invisible characters render without complaint", async () => {
    const pdf = await typstWasmRenderer().render({ markdown: "# Café — “Ελληνικά”, Русский\u200B\uFE0F" });
    expect(pages(pdf)).toBe(1);
  });

  test("a provider that fails, leaving characters uncovered, is an error that says why", async () => {
    const failing = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const subsets = googleFontSubsets({ families: [{ family: "Noto Sans JP" }], fetch: failing });
    const err = await typstWasmRenderer({ fonts: [subsets] }).render({ markdown: "# 日本語のテキスト" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfRenderError);
    expect((err as Error).message).toContain("covers 日 本 語");
    expect((err as Error).message).toContain("google-font-subsets failed (Noto Sans JP 400: Google Fonts CSS: HTTP 503)");
  });

  test("one weight failing keeps the weights that loaded", async () => {
    const { fetcher } = googleStub();
    const boldFails = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("wght@700") ? new Response("no", { status: 503 }) : fetcher(input, init)) as typeof fetch;
    const subsets = googleFontSubsets({ families: [{ family: "Inter", weights: [400, 700] }], fetch: boldFails });
    const got = await subsets.forDocument!("é");
    expect(got.fonts.length).toBe(1);
    expect(got.failed).toEqual(["Inter 700: Google Fonts CSS: HTTP 503"]);
    // The regular subset still typesets the document.
    const pdf = await typstWasmRenderer({ fonts: [subsets], fontFamilies: ["Inter"] }).render({ markdown: "Café" });
    expect(fonts(pdf)).toEqual(expect.arrayContaining([expect.stringMatching(/^Inter/)]));
  });

  test('onMissingGlyphs: "warn" returns the PDF and logs the characters', async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pdf = await typstWasmRenderer({ onMissingGlyphs: "warn" }).render({ markdown: "# Done 😀" });
      expect(pages(pdf)).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("covers 😀,");
    } finally {
      warn.mockRestore();
    }
  });

  test("localFonts register once and serve every document; a URL is fetched once", async () => {
    const { calls, fetcher } = googleStub();
    const r = typstWasmRenderer({ fonts: [localFonts(["https://fonts.gstatic.test/inter.ttf"], { fetch: fetcher })], fontFamilies: ["Inter"] });
    for (const markdown of ["# One", "# Two"]) expect(fonts(await r.render({ markdown }))).toEqual(expect.arrayContaining([expect.stringMatching(/^Inter/)]));
    expect(calls.map((c) => c.url)).toEqual(["https://fonts.gstatic.test/inter.ttf"]);
  });

  test("a local font that can't be read fails the render, and the next render retries", async () => {
    let attempts = 0;
    const flaky = localFonts([async () => (++attempts === 1 ? Promise.reject(new Error("disk")) : latinFont)]);
    const r = typstWasmRenderer({ fonts: [flaky] });
    await expect(r.render({ markdown: "# A" })).rejects.toThrow("disk");
    expect(pages(await r.render({ markdown: "# A" }))).toBe(1);
  });

  test("render_pdf on this renderer stores the PDF and returns the ref", async () => {
    const [tool] = pdfTools({ renderer: typstWasmRenderer() });
    const files = memoryFileStore();
    const out = (await tool!.run({ markdown: "# Q3 report\n\nAll good.", filename: "q3.pdf" }, { files } as unknown as ToolContext)) as { file: { id: string; name: string } };
    expect(out.file.name).toBe("q3.pdf");
    expect(latin1.decode((await files.get(out.file.id))!.slice(0, 5))).toBe("%PDF-");
  });

  test("render_pdf fails with the missing glyphs error, so the model sees it", async () => {
    const [tool] = pdfTools({ renderer: typstWasmRenderer() });
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
