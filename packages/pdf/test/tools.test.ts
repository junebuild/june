// render_pdf over a fake renderer: what reaches the renderer, what reaches the FileStore,
// and what the model reads back. The Typst renderer has its own test.

import { describe, expect, test } from "bun:test";

import { memoryFileStore } from "@junejs/core/agent-files";
import type { ToolContext } from "@junejs/core/agent-runtime";
import { pdfFilename, pdfTools, PdfRenderError, type PdfDocument, type PdfRenderer } from "@junejs/pdf";

function fakeRenderer(out = "%PDF-1.7 fake"): PdfRenderer & { docs: PdfDocument[] } {
  const docs: PdfDocument[] = [];
  return { name: "fake", docs, render: async (doc) => { docs.push(doc); return new TextEncoder().encode(out); } };
}

function ctx(files = memoryFileStore()): ToolContext {
  return { files } as unknown as ToolContext;
}

describe("pdfTools", () => {
  test("one remote tool named render_pdf, Markdown required", () => {
    const [tool, ...rest] = pdfTools({ renderer: fakeRenderer() });
    expect(rest).toEqual([]);
    expect(tool!.spec.name).toBe("render_pdf");
    expect(tool!.mode).toBe("remote");
    expect((tool!.spec.input as { required: string[] }).required).toEqual(["markdown"]);
    expect(tool!.requiresPrincipal).toBeUndefined();
    expect(pdfTools({ renderer: fakeRenderer(), name: "invoice_pdf", requiresPrincipal: true })[0]).toMatchObject({ spec: { name: "invoice_pdf" }, requiresPrincipal: true });
  });

  test("renders, stores the bytes as application/pdf and returns the ref with a note", async () => {
    const renderer = fakeRenderer();
    const files = memoryFileStore();
    const [tool] = pdfTools({ renderer, defaults: { author: "Ops bot", lang: "en", paper: "us-letter" } });
    const out = (await tool!.run({ markdown: "# Weekly revenue\n\nUp 12%.", lang: "zh-TW" }, ctx(files))) as { file: { id: string; name: string; mediaType: string; size: number }; note: string };
    expect(renderer.docs).toEqual([{ markdown: "# Weekly revenue\n\nUp 12%.", title: "Weekly revenue", author: "Ops bot", lang: "zh-TW", paper: "us-letter" }]);
    expect(out.file).toMatchObject({ $june: "file", name: "Weekly revenue.pdf", mediaType: "application/pdf", size: 13 });
    expect(out.note).toBe("Weekly revenue.pdf (13 B) is attached to the conversation.");
    expect(new TextDecoder().decode((await files.get(out.file.id))!)).toBe("%PDF-1.7 fake");
  });

  test("an explicit filename and title win over the heading", async () => {
    const renderer = fakeRenderer();
    const [tool] = pdfTools({ renderer });
    const out = (await tool!.run({ markdown: "# Heading", title: "Q3 report", filename: "q3.pdf" }, ctx())) as { file: { name: string } };
    expect(out.file.name).toBe("q3.pdf");
    expect(renderer.docs[0]!.title).toBe("Q3 report");
  });

  test("refuses empty and oversized Markdown before rendering", async () => {
    const renderer = fakeRenderer();
    const [tool] = pdfTools({ renderer, maxMarkdownLength: 10 });
    await expect(Promise.resolve(tool!.run({ markdown: "  " }, ctx()))).rejects.toThrow(/non-empty/);
    await expect(Promise.resolve(tool!.run({ markdown: "x".repeat(11) }, ctx()))).rejects.toThrow(/limit is 10/);
    expect(renderer.docs).toEqual([]);
  });

  test("a renderer's error propagates for the engine to hand the model", async () => {
    const [tool] = pdfTools({ renderer: { name: "broken", render: async () => { throw new PdfRenderError("unclosed delimiter at line 3"); } } });
    await expect(Promise.resolve(tool!.run({ markdown: "# x" }, ctx()))).rejects.toThrow("unclosed delimiter at line 3");
  });
});

describe("pdfFilename", () => {
  test("keeps any script, strips separators and control characters, adds .pdf once", () => {
    expect(pdfFilename("營收報告 2026 W41")).toBe("營收報告 2026 W41.pdf");
    expect(pdfFilename("report.PDF")).toBe("report.pdf");
    expect(pdfFilename("../../etc/passwd")).toBe("etc-passwd.pdf");
    expect(pdfFilename("a\u0000b\nc")).toBe("a-b-c.pdf");
    expect(pdfFilename("  ...  ")).toBe("document.pdf");
    expect([...pdfFilename("字".repeat(300))].length).toBe(104);
  });
});
