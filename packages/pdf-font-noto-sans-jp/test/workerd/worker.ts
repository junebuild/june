// The smoke Worker (scripts/smoke-workerd.ts): both packages as an app installs them, resolved
// through the `workerd` export condition to their dist, the fonts uploaded as Data modules. No
// network: the renderer's only fonts are the embedded ones and these.
import { notoSansJP } from "@junejs/pdf-font-noto-sans-jp";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

const renderer = typstWasmRenderer({ fonts: [notoSansJP()] });

export default {
  async fetch(req: Request): Promise<Response> {
    const markdown = req.method === "POST" ? await req.text() : "# 四半期報告\n\n**売上**は12%増加しました。ひらがな、カタカナ、漢字。";
    try {
      const pdf = await renderer.render({ markdown, lang: "ja" });
      return new Response(pdf.slice(), { headers: { "content-type": "application/pdf" } });
    } catch (err) {
      return new Response(String(err instanceof Error ? err.message : err), { status: 500 });
    }
  },
};
