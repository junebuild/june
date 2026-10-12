// @junejs/pdf — PDF output as an agent capability (docs/rfc-agent-files.md §4): the
// render_pdf tool (pdfTools) over a replaceable PdfRenderer.

export { pdfTools, pdfFilename, type PdfToolsOptions, type RenderPdfInput, type RenderPdfResult } from "./tools";
export { PdfRenderError, type PdfDocument, type PdfPaper, type PdfRenderer } from "./renderer";
