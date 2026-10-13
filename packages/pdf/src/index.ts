// @junejs/pdf — PDF output as an agent capability (docs/rfc-agent-files.md §4): the
// render_pdf tool (pdfTools) over a replaceable PdfRenderer. The bundled renderer, Typst on
// WebAssembly, is its own entry: `import { typstRenderer } from "@junejs/pdf/typst"`.

export { pdfTools, pdfFilename, type PdfToolsOptions, type RenderPdfInput, type RenderPdfResult } from "./tools";
export { PdfRenderError, type PdfDocument, type PdfPaper, type PdfRenderer } from "./renderer";
// The Markdown → Typst source conversion, for any renderer built on a Typst compiler (the
// bundled typstRenderer, @junejs/pdf-typst-wasm, or one an app writes).
export { markdownToTypst, typstSource, type TypstSourceOptions } from "./markdown-typst";
