// june.build site smoke suite — the site is its own dual-audience demo, so the
// tests assert BOTH surfaces. Run: bun test apps/june.build
// Regenerate content first if posts/docs changed: bun packages/cli/src/june.ts gen apps/june.build
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createApp, loadJuneConfig, type JuneApp } from "@junejs/server";

const ROOT = import.meta.dirname;

let app: JuneApp;
const get = (path: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`http://june.build${path}`, { headers }));
const rpc = (body: object) =>
  app
    .fetch(
      new Request("http://june.build/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      }),
    )
    .then((r) => r.json() as Promise<any>);

beforeAll(async () => {
  const config = await loadJuneConfig(ROOT);
  app = createApp({ appDir: join(ROOT, "app"), config });
  await app.warmup(); // registers search_site / get_page (page.tsx imports actions)
});

describe("human surface", () => {
  test("landing, why, benchmarks render in the layout", async () => {
    for (const [path, marker] of [
      ["/", "One definition, five surfaces"],
      ["/why", "The wedge"],
      ["/benchmarks", "48k ops/s"],
    ] as const) {
      const html = await (await get(path)).text();
      expect(html).toContain('data-layout="root"');
      expect(html).toContain(marker);
    }
  });

  test("each page gets its own templated title", async () => {
    expect(await (await get("/why")).text()).toContain("<title>Why June · June</title>");
    expect(await (await get("/benchmarks")).text()).toContain("<title>Benchmarks · June</title>");
    expect(await (await get("/")).text()).toContain(
      "<title>June — the agent-ready React framework</title>",
    );
  });

  test("404 boundary", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('data-boundary="not-found"');
  });
});

describe("blog (content pipeline)", () => {
  test("list + post render from the frozen manifest", async () => {
    const list = await (await get("/blog")).text();
    expect(list).toContain("Building june.build with June");
    expect(list).toContain("59ms");
    const html = await (await get("/blog/2026-06-12-building-june-build-with-june")).text();
    expect(html).toContain("<title>Building june.build with June · June</title>");
    expect(html).toContain("byte for byte");
  });

  test(".md projection is the authored file, verbatim", async () => {
    const served = await (
      await get("/blog/2026-06-10-anatomy-of-a-59ms-cold-start.md")
    ).text();
    const authored = await Bun.file(
      join(ROOT, "content/posts/2026-06-10-anatomy-of-a-59ms-cold-start.md"),
    ).text();
    expect(served).toBe(authored);
  });

  test("CJK typesetting showcase renders all four scripts", async () => {
    const html = await (await get("/blog/2026-06-10-typesetting-cjk-at-the-edge")).text();
    expect(html).toContain("<title>Typesetting CJK at the edge: og:image and font subsetting · June</title>");
    expect(html).toContain("エッジで日本語を組版する");
    expect(html).toContain("邊緣排版與字型子集化");
    expect(html).toContain("边缘排版与字体子集化");
    expect(html).toContain("글꼴 서브셋");
  });
});

describe("docs", () => {
  test("index lists docs inside the nested layout", async () => {
    const html = await (await get("/docs")).text();
    expect(html).toContain('data-layout="docs"');
    expect(html).toContain("Getting started");
  });

  test("doc page serves authored markdown at .md", async () => {
    const served = await (await get("/docs/01-getting-started.md")).text();
    const authored = await Bun.file(join(ROOT, "content/docs/01-getting-started.md")).text();
    expect(served).toBe(authored);
  });
});

describe("agent surface", () => {
  test("llms.txt + sitemap + api-catalog resolve", async () => {
    const llms = await (await get("/llms.txt")).text();
    expect(llms).toContain("/why");
    expect((await get("/sitemap.xml")).status).toBe(200);
    expect((await get("/.well-known/api-catalog")).status).toBe(200);
  });

  test("/mcp lists the site tools", async () => {
    const res = await rpc({ method: "tools/list", params: {} });
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("search_site");
    expect(names).toContain("get_page");
  });

  test("search_site finds the cold-start post; get_page returns verbatim markdown", async () => {
    const search = await rpc({
      method: "tools/call",
      params: { name: "search_site", arguments: { query: "cold start" } },
    });
    const cards = JSON.parse(search.result.content[0].text);
    expect(cards.some((c: any) => c.slug.includes("cold-start"))).toBe(true);

    const page = await rpc({
      method: "tools/call",
      params: { name: "get_page", arguments: { slug: "why" } },
    });
    const why = JSON.parse(page.result.content[0].text);
    expect(why.markdown).toContain("## The bet");
  });
});
