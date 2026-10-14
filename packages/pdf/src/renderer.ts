// The PdfRenderer seam (docs/rfc-agent-files.md §4). PDF output is a capability an app
// opts into, and HOW the PDF is produced is the app's choice: Typst on WebAssembly runs in
// process but costs a 28 MB module and tens of MB of memory per document; a headless
// browser renders HTML/CSS faithfully but needs one; a remote service needs none of it
// locally. So the tool depends on this interface only, and every
// engine — @junejs/pdf-typst-wasm's, or one an app writes — implements it.

// What a renderer is asked to produce. Markdown is the input because it is what a model
// writes best and what a skill can teach in a page; layout stays the renderer's job.
export type PdfDocument = {
  markdown: string;
  title?: string; // the PDF's document title (metadata); not inserted into the body
  author?: string;
  lang?: string; // BCP 47, e.g. "zh-TW" — drives hyphenation, quotes and CJK line breaking
  paper?: PdfPaper;
};

export type PdfPaper = "a4" | "us-letter";

export interface PdfRenderer {
  // Shown in errors and logs ("typst", "browser-rendering", …).
  readonly name: string;
  // The PDF's bytes. Throw a PdfRenderError for a problem with the document itself (the
  // model can fix its Markdown and retry); anything else is the renderer's own failure.
  render(doc: PdfDocument): Promise<Uint8Array>;
}

// A document the renderer could not typeset: the message is written for the model, which
// reads it as the tool's error and can rewrite the Markdown.
export class PdfRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfRenderError";
  }
}
