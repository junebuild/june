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

- `pdfTools({ renderer })` adds a `render_pdf` tool: the model writes Markdown, the PDF is stored through `ctx.files` and attached to the conversation (in Slack, uploaded into the thread).
- The renderer is replaceable: anything that implements `PdfRenderer` (`render(doc) → Uint8Array`) works, such as a headless browser or a remote service.
- `typstRenderer()` typesets on the Typst compiler built for WebAssembly. Install `@myriaddreamin/typst.ts` and `@myriaddreamin/typst-ts-web-compiler` to use it. It runs on Bun, Node and Deno, **not on Cloudflare Workers** (the WASM is larger than the Workers bundle limit). It loads typst.ts's hosted Latin and Simplified Chinese fonts by default; for Traditional Chinese, Japanese or Korean, pass a font that covers it in `fonts`.
- Copy `node_modules/@junejs/pdf/skills/pdf-report.md` into `agent/skills/` to teach the model how to write the document and when to call the tool.
