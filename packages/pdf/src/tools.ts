// pdfTools — PDF output as an agent capability (docs/rfc-agent-files.md §4):
//
//   // agent/tools/pdf.ts
//   import { pdfTools } from "@junejs/pdf";
//   import { typstRenderer } from "@junejs/pdf/typst";
//   export default pdfTools({ renderer: typstRenderer() });
//
// One tool, render_pdf: Markdown in, a FileRef out. The bytes go to ctx.files (the host's
// FileStore), the ref goes back to the model and into the durable log, and the engine's
// file.attached event lets the channel deliver the PDF (a Slack upload into the thread).
//
// A plain Tool, not a defineAction: an action's run receives the action context (the
// principal), not the ToolContext, and ctx.files lives on the ToolContext.

import type { FileRef } from "@junejs/core/agent-files";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";

import type { PdfDocument, PdfPaper, PdfRenderer } from "./renderer";

export type PdfToolsOptions = {
  renderer: PdfRenderer;
  // The tool's name, for an agent that wires two renderers (default "render_pdf").
  name?: string;
  // Applied to every document; the model's own arguments win where it gives them.
  defaults?: Pick<PdfDocument, "author" | "lang" | "paper">;
  // Expose the tool only on turns with a resolved identity (see Tool.requiresPrincipal) —
  // for an agent whose PDFs carry tenant data.
  requiresPrincipal?: boolean;
  // Refuse Markdown longer than this many characters (default 200 000) — a runaway model
  // must not hand the renderer a megabyte of text.
  maxMarkdownLength?: number;
};

export type RenderPdfInput = {
  markdown: string;
  filename?: string;
  title?: string;
  lang?: string;
  paper?: PdfPaper;
};

export type RenderPdfResult = { file: FileRef; note: string };

const PDF_MEDIA_TYPE = "application/pdf";
const MAX_MARKDOWN = 200_000;

export function pdfTools(opts: PdfToolsOptions): Tool[] {
  const name = opts.name ?? "render_pdf";
  const max = opts.maxMarkdownLength ?? MAX_MARKDOWN;
  const tool: Tool = {
    spec: {
      name,
      description:
        "Typeset Markdown into a PDF and attach it to the conversation. Use it when the user asks for a PDF, a report to download or print, or a document to share. " +
        "Write the complete document as Markdown (headings, paragraphs, lists, tables, code blocks, links). The user receives the PDF as an attachment; " +
        "reply with a short note about what it contains instead of repeating it.",
      input: {
        type: "object",
        properties: {
          markdown: { type: "string", description: "The whole document, in Markdown. Start with a # heading for the title." },
          filename: { type: "string", description: 'The attachment\'s filename, e.g. "revenue-2026-w41.pdf". Defaults to the title.' },
          title: { type: "string", description: "The document title (PDF metadata). Defaults to the first heading." },
          lang: { type: "string", description: 'The document language as a BCP 47 tag, e.g. "en", "zh-TW", "ja".' },
          paper: { type: "string", enum: ["a4", "us-letter"], description: "Paper size (default a4)." },
        },
        required: ["markdown"],
      },
    },
    mode: "remote",
    run: async (input: RenderPdfInput, ctx: ToolContext): Promise<RenderPdfResult> => {
      if (typeof input?.markdown !== "string" || !input.markdown.trim()) throw new Error("render_pdf: `markdown` must be a non-empty string");
      if (input.markdown.length > max) throw new Error(`render_pdf: the Markdown is ${input.markdown.length} characters; the limit is ${max} — shorten the document`);
      const title = input.title?.trim() || firstHeading(input.markdown);
      const doc: PdfDocument = {
        markdown: input.markdown,
        ...(title ? { title } : {}),
        ...dropUndefined({ author: opts.defaults?.author, lang: input.lang ?? opts.defaults?.lang, paper: input.paper ?? opts.defaults?.paper }),
      };
      const bytes = await opts.renderer.render(doc);
      const filename = pdfFilename(input.filename || title || "document");
      const file = await ctx.files.put(bytes, { name: filename, mediaType: PDF_MEDIA_TYPE });
      return { file, note: `${filename} (${formatSize(file.size)}) is attached to the conversation.` };
    },
  };
  if (opts.requiresPrincipal) tool.requiresPrincipal = true;
  return [tool];
}

function dropUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// The first ATX heading's text, as a fallback title. Setext headings and headings inside
// code fences are rare in model output; missing them only costs the fallback.
function firstHeading(markdown: string): string | undefined {
  const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(markdown);
  return m?.[1]?.replace(/[*_`]/g, "").trim() || undefined;
}

// A filename every channel accepts: no path separators or control characters, a bounded
// length, and the .pdf extension. Letters of any script survive — a Chinese title stays a
// Chinese filename.
export function pdfFilename(raw: string): string {
  let base = raw
    .normalize("NFC")
    .replace(/\.pdf$/i, "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "");
  if ([...base].length > 100) base = [...base].slice(0, 100).join("").trim();
  return `${base || "document"}.pdf`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
