// typstRenderer against the real Typst WASM compiler, offline: the hosted font sets are off
// and the one font is the Inter subset @junejs/server already ships for favicons, so the
// default suite makes no network call. Hosted fonts and CJK coverage are exercised by the
// live test (PDF_TYPST_LIVE=1), which fetches them.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { PdfRenderError } from "@junejs/pdf";
import { typstRenderer } from "@junejs/pdf/typst";

const inter = new Uint8Array(await readFile(new URL("../../june/assets/icon-latin.ttf", import.meta.url)));
const latin1 = new TextDecoder("latin1");

// The PDF's own structure, read without a PDF library: page objects and embedded fonts.
function inspect(pdf: Uint8Array) {
  const s = latin1.decode(pdf);
  return {
    header: s.slice(0, 5),
    pages: (s.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length,
    fonts: [...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]!))],
  };
}

describe("typstRenderer (offline, real WASM)", () => {
  const renderer = typstRenderer({ fonts: [inter], fontAssets: false, fontFamilies: ["Inter"] });

  test("renders Markdown to a PDF with the given font embedded", async () => {
    const pdf = await renderer.render({
      title: "Weekly revenue",
      markdown: [
        "# Weekly revenue",
        "",
        "Revenue grew **12%** to $48,200 — see [the dashboard](https://example.com/d?x=1&y=2).",
        "",
        "| Region | Revenue |",
        "|:--|--:|",
        "| North | 21,000 |",
        "| South | 27,200 |",
        "",
        "- email ops@example.com",
        "- `#hashtag` and // slashes",
        "",
        "```ts",
        'const total = 21_000 + 27_200; // "48,200"',
        "```",
      ].join("\n"),
    });
    const info = inspect(pdf);
    expect(info.header).toBe("%PDF-");
    expect(info.pages).toBe(1);
    expect(info.fonts.some((f) => f.startsWith("Inter"))).toBe(true);
  }, 60_000);

  test("long documents paginate", async () => {
    const markdown = Array.from({ length: 120 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of the long report.`).join("\n\n");
    expect(inspect(await renderer.render({ markdown, paper: "us-letter" })).pages).toBeGreaterThan(3);
  }, 60_000);

  test("concurrent renders run in order and each gets its own document", async () => {
    const [a, b] = await Promise.all([renderer.render({ markdown: "# A" }), renderer.render({ markdown: Array(200).fill("B line.").join("\n\n") })]);
    expect(inspect(a).pages).toBe(1);
    expect(inspect(b).pages).toBeGreaterThan(1);
  }, 60_000);

  test("PdfRenderError is exported for renderers to signal a bad document", () => {
    expect(new PdfRenderError("x")).toBeInstanceOf(Error);
  });
});
