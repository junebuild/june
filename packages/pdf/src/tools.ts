// pdfTools — PDF output as an agent capability (docs/rfc-agent-files.md §4):
//
//   // agent/tools/pdf.ts
//   import { pdfTools } from "@junejs/pdf";
//   import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";
//   export default pdfTools({ renderer: typstWasmRenderer() });
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
    run: async (raw: unknown, ctx: ToolContext): Promise<RenderPdfResult> => {
      const input = validateInput(name, raw, max);
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

// The engine does not check a call against `spec.input`, and models send malformed optional
// fields (a number for `title`, "A4" or "letter" for `paper`, a sentence for `lang`). Check
// every field and report every problem in one message the model can act on; null counts as
// absent, since models often send it for a field they mean to omit.
const PAPERS: readonly PdfPaper[] = ["a4", "us-letter"];
const LANG = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;
function validateInput(tool: string, raw: unknown, max: number): RenderPdfInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${tool}: the input must be an object with a \`markdown\` string`);
  const i = raw as Record<string, unknown>;
  const problems: string[] = [];
  const optionalString = (key: string): string | undefined => {
    const v = i[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") { problems.push(`\`${key}\` must be a string`); return undefined; }
    return v;
  };
  const markdown = i.markdown;
  if (typeof markdown !== "string" || !markdown.trim()) problems.push("`markdown` must be a non-empty string");
  else if (markdown.length > max) problems.push(`the Markdown is ${markdown.length} characters; the limit is ${max} — shorten the document`);
  const filename = optionalString("filename");
  const title = optionalString("title");
  const lang = optionalString("lang");
  if (lang !== undefined && !LANG.test(lang)) problems.push(`\`lang\` must be a BCP 47 language tag such as "en" or "zh-TW", not ${JSON.stringify(lang)}`);
  const paper = optionalString("paper");
  if (paper !== undefined && !PAPERS.includes(paper as PdfPaper)) problems.push(`\`paper\` must be one of ${PAPERS.map((p) => `"${p}"`).join(", ")}, not ${JSON.stringify(paper)}`);
  if (problems.length) throw new Error(`${tool}: ${problems.join("; ")}`);
  return { markdown: markdown as string, ...dropUndefined({ filename, title, lang, paper: paper as PdfPaper | undefined }) };
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
