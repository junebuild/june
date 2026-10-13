// The smoke Worker (scripts/smoke-workerd.ts): the package as an app installs it, resolved
// through the `workerd` export condition to dist/workerd.js, which imports the engine module
// for wrangler to upload precompiled. No network: googleFonts is off.
import { pdfTools } from "@junejs/pdf";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

const renderer = typstWasmRenderer({ googleFonts: false });
let renders = 0;

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/tool") {
      // render_pdf through pdfTools, with a FileStore stand-in, as an agent would call it.
      const stored: Uint8Array[] = [];
      const files = { put: async (data: Uint8Array, meta: { name: string; mediaType: string }) => (stored.push(data), { $june: "file", id: "x", name: meta.name, mediaType: meta.mediaType, size: data.length }), get: async () => null };
      const [tool] = pdfTools({ renderer });
      const out = (await tool!.run({ markdown: "# From the tool\n\nRendered on workerd." }, { files } as never)) as { file: { name: string } };
      return new Response(stored[0]!.slice(), { headers: { "content-type": "application/pdf", "x-filename": out.file.name } });
    }
    const markdown = req.method === "POST" ? await req.text() : "# Weekly revenue\n\nRevenue grew **12%**.\n\n| Region | Revenue |\n|:--|--:|\n| North | 21,000 |";
    try {
      const pdf = await renderer.render({ markdown, title: "smoke" });
      return new Response(pdf.slice(), { headers: { "content-type": "application/pdf", "x-renders": String(++renders) } });
    } catch (err) {
      return new Response(String(err instanceof Error ? err.message : err), { status: 500 });
    }
  },
};
