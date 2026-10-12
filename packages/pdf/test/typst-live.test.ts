// typstRenderer with typst.ts's hosted font sets, fetched from jsdelivr — the default
// configuration an app gets. Skipped unless PDF_TYPST_LIVE=1 (the default suite makes no
// network call).

import { describe, expect, test } from "bun:test";

import { typstRenderer } from "@junejs/pdf/typst";

const live = process.env.PDF_TYPST_LIVE === "1";

describe.skipIf(!live)("typstRenderer (live: hosted fonts)", () => {
  test("Latin, monospace and Simplified Chinese text embed their fonts", async () => {
    const pdf = await typstRenderer().render({
      title: "营收报告",
      lang: "zh-CN",
      markdown: "# 营收报告\n\n上周营收增长 **12%**，详见 `revenue.sql`。\n\nRevenue grew 12%.",
    });
    const s = new TextDecoder("latin1").decode(pdf);
    const fonts = [...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g)].map((m) => m[1]))];
    expect(fonts).toEqual(expect.arrayContaining([expect.stringMatching(/^LibertinusSerif/), expect.stringMatching(/^NotoSerifCJKsc/), expect.stringMatching(/^DejaVuSansMono/)]));
  }, 120_000);
});
