// @junejs/pdf — PDF output as an agent capability (docs/rfc-agent-files.md §4): the
// render_pdf tool (pdfTools) over a replaceable PdfRenderer. June's renderer, Typst on
// WebAssembly, is its own package: `import { typstWasmRenderer } from "@junejs/pdf-typst-wasm"`.

export { pdfTools, pdfFilename, type PdfToolsOptions, type RenderPdfInput, type RenderPdfResult } from "./tools";
export { PdfRenderError, type PdfDocument, type PdfPaper, type PdfRenderer } from "./renderer";
// The Markdown → Typst source conversion, for any renderer built on a Typst compiler
// (@junejs/pdf-typst-wasm, or one an app writes).
export { markdownToTypst, typstSource, type TypstSourceOptions } from "./markdown-typst";
