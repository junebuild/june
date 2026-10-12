---
"@junejs/pdf": minor
---

New package: PDF output as an agent capability.

```ts
// agent/tools/pdf.ts
import { pdfTools } from "@junejs/pdf";
import { typstRenderer } from "@junejs/pdf/typst";

export default pdfTools({ renderer: typstRenderer() });
```

- `pdfTools({ renderer })` adds a `render_pdf` tool: the model writes Markdown, the PDF is stored through `ctx.files` and attached to the conversation (in Slack, uploaded into the thread) Every input field is validated, and the model gets one error listing every problem.
- The renderer is replaceable: anything that implements `PdfRenderer` (`render(doc) → Uint8Array`) works, such as a headless browser or a remote service.
- `typstRenderer()` typesets on the Typst compiler built for WebAssembly. Install `@myriaddreamin/typst.ts` and `@myriaddreamin/typst-ts-web-compiler` to use it. It is verified on Bun and Node. On Cloudflare Workers the 28 MB module fits the 64 MiB size limit, but the renderer is not yet verified there: pass the compiled module as `wasm`, and use Workers Paid (one page takes more than the Free plan's 10 ms of CPU). It loads typst.ts's hosted Latin and Simplified Chinese fonts by default; for Traditional Chinese, Japanese or Korean, pass a font that covers it in `fonts`.
- Copy `node_modules/@junejs/pdf/skills/pdf-report.md` into `agent/skills/` to teach the model how to write the document and when to call the tool.
