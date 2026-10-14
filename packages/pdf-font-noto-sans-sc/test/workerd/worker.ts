// The smoke Worker (scripts/smoke-workerd.ts): both packages as an app installs them, resolved
// through the `workerd` export condition to their dist, the fonts uploaded as Data modules. No
// network: the renderer's only fonts are the embedded ones and these.
import { notoSansSC } from "@junejs/pdf-font-noto-sans-sc";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

const renderer = typstWasmRenderer({ fonts: [notoSansSC()] });

export default {
  async fetch(req: Request): Promise<Response> {
    const markdown = req.method === "POST" ? await req.text() : "# 季度报告\n\n**营收**增长 12%。简体中文：龘、齉、爩。";
    try {
      const pdf = await renderer.render({ markdown, lang: "zh-CN" });
      return new Response(pdf.slice(), { headers: { "content-type": "application/pdf" } });
    } catch (err) {
      return new Response(String(err instanceof Error ? err.message : err), { status: 500 });
    }
  },
};
