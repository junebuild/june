// The smoke Worker (scripts/smoke-workerd.ts): both packages as an app installs them, resolved
// through the `workerd` export condition to their dist, the fonts uploaded as Data modules. No
// network: the renderer's only fonts are the embedded ones and these.
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

const renderer = typstWasmRenderer({ fonts: [notoSansTC()] });

export default {
  async fetch(req: Request): Promise<Response> {
    const markdown = req.method === "POST" ? await req.text() : "# 季度報告\n\n**營收**成長 12%。臺灣、裏、峯。";
    try {
      const pdf = await renderer.render({ markdown, lang: "zh-TW" });
      return new Response(pdf.slice(), { headers: { "content-type": "application/pdf" } });
    } catch (err) {
      return new Response(String(err instanceof Error ? err.message : err), { status: 500 });
    }
  },
};
