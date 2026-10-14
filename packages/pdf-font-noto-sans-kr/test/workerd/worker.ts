// The smoke Worker (scripts/smoke-workerd.ts): both packages as an app installs them, resolved
// through the `workerd` export condition to their dist, the fonts uploaded as Data modules. No
// network: the renderer's only fonts are the embedded ones and these.
import { notoSansKR } from "@junejs/pdf-font-noto-sans-kr";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

const renderer = typstWasmRenderer({ fonts: [notoSansKR()] });

export default {
  async fetch(req: Request): Promise<Response> {
    const markdown = req.method === "POST" ? await req.text() : "# 분기 보고서\n\n**매출**이 12% 증가했습니다. 한글과 漢字.";
    try {
      const pdf = await renderer.render({ markdown, lang: "ko" });
      return new Response(pdf.slice(), { headers: { "content-type": "application/pdf" } });
    } catch (err) {
      return new Response(String(err instanceof Error ? err.message : err), { status: 500 });
    }
  },
};
