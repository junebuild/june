// june.build site smoke suite — the site is its own dual-audience demo, so the
// tests assert BOTH surfaces. Run: bun test apps/june.build
// Regenerate content first if posts/docs changed: bun packages/cli/src/june.ts gen apps/june.build
import { beforeAll, describe, expect, test } from "bun:test";
import { createSlugger } from "@junejs/core/slug";
import { join } from "node:path";

import { createApp, loadJuneConfig, type JuneApp } from "@junejs/server";

import { DOCS, POSTS } from "./app/_content";
import { ogOptions } from "./app/og-options";

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

describe("heading anchors (app/headings.ts)", () => {
  test("adds a # link to h2–h4 using the framework's id; other levels untouched", async () => {
    const { withAnchorLinks } = await import("./app/headings");
    const out = withAnchorLinks('<h1 id="top">Top</h1><h2 id="setup">Set <code>up</code></h2><h4 id="deep">Deep</h4><h5 id="x">X</h5>');
    expect(out).toBe(
      '<h1 id="top">Top</h1>' +
        '<h2 id="setup">Set <code>up</code><a class="j-anchor" href="#setup" aria-label="Link to this section">#</a></h2>' +
        '<h4 id="deep">Deep<a class="j-anchor" href="#deep" aria-label="Link to this section">#</a></h4>' +
        '<h5 id="x">X</h5>',
    );
    // a raw-HTML heading keeps its other attributes; one without an id is left alone
    expect(withAnchorLinks('<h2 class="warning" id="title">Title</h2>')).toBe(
      '<h2 class="warning" id="title">Title<a class="j-anchor" href="#title" aria-label="Link to this section">#</a></h2>',
    );
    expect(withAnchorLinks('<h3 class="x">No id</h3>')).toBe('<h3 class="x">No id</h3>');
  });
});

describe("human surface", () => {
  test("landing, why, benchmarks render in the layout", async () => {
    for (const [path, marker] of [
      ["/", "The directory is the manifest."],
      ["/why", "Core design philosophy"],
      ["/benchmarks", "48k ops/s"],
    ] as const) {
      const html = await (await get(path)).text();
      expect(html).toContain('data-layout="root"');
      expect(html).toContain(marker);
    }
  });

  test("trust pages: /about, /contact, /privacy render their authored file and serve it as .md", async () => {
    for (const slug of ["about", "contact", "privacy"]) {
      const authored = await Bun.file(join(ROOT, `content/pages/${slug}.md`)).text();
      const body = authored.replace(/^---[\s\S]*?---\n/, "");
      expect(body.length, slug).toBeGreaterThan(500); // real content, not a stub
      const html = await (await get(`/${slug}`)).text();
      expect(html).toContain('data-layout="root"');
      // the authored body itself is rendered, not just the shared layout
      const firstHeading = body.match(/^## (.+)$/m)![1]!;
      expect(html, slug).toMatch(new RegExp(`<h2[^>]*>(?:<a[^>]*>)?\\s*${firstHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      expect(html).toContain(`href="/${slug}"`); // linked from the footer
      expect(await (await get(`/${slug}.md`)).text()).toBe(authored);
    }
  });

  test("homepage JSON-LD names who runs the site and what it is", async () => {
    const html = await (await get("/")).text();
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!);
    const byType = (t: string) => ld["@graph"].find((n: { "@type": string }) => n["@type"] === t);
    expect(byType("WebSite").publisher).toEqual({ "@id": byType("Organization")["@id"] });
    expect(byType("Organization").sameAs).toEqual(
      expect.arrayContaining([
        "https://github.com/junebuild",
        "https://www.npmjs.com/org/junejs",
        "https://x.com/junebuild",
      ]),
    );
    expect(byType("SoftwareApplication").applicationCategory).toBe("DeveloperApplication");
    expect(byType("SoftwareSourceCode").codeRepository).toBe("https://github.com/junebuild/june");
  });

  test("the homepage FAQ has ONE source: its section, /index.md, and the FAQPage JSON-LD agree", async () => {
    const { FAQ } = await import("./faq");
    const html = await (await get("/")).text();
    const md = await (await get("/index.md")).text();
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!);
    const faqPage = ld["@graph"].find((n: { "@type": string }) => n["@type"] === "FAQPage");
    expect(faqPage.mainEntity.map((q: { name: string }) => q.name)).toEqual(FAQ.map((f) => f.q));
    for (const f of FAQ) {
      expect(html).toContain(`<h3>${f.q.replace(/'/g, "&#x27;")}</h3>`);
      expect(md).toContain(`### ${f.q}\n\n${f.a}`);
      // JSON-LD answers are plain text: the Markdown code ticks are dropped
      const answer = faqPage.mainEntity.find((q: { name: string }) => q.name === f.q).acceptedAnswer.text;
      expect(answer).toBe(f.a.replace(/`/g, ""));
    }
  });

  test("docs and blog pages place themselves in the site: June › Docs|Blog › <page>", async () => {
    const trail = async (path: string) => {
      const html = await (await get(path)).text();
      const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!);
      const list = ld["@graph"].find((n: { "@type": string }) => n["@type"] === "BreadcrumbList");
      return list.itemListElement.map((i: { name: string; item: string }) => [i.name, i.item]);
    };
    const { DOCS, POSTS } = await import("./app/_content");
    const d = DOCS[0]!;
    expect(await trail(`/docs/${d.slug}`)).toEqual([
      ["June", "https://june.build/"],
      ["Docs", "https://june.build/docs"],
      [String(d.data.title), `https://june.build/docs/${d.slug}`],
    ]);
    const p = POSTS[0]!;
    expect(await trail(`/blog/${p.slug}`)).toEqual([
      ["June", "https://june.build/"],
      ["Blog", "https://june.build/blog"],
      [String(p.data.title), `https://june.build/blog/${p.slug}`],
    ]);
    expect(await trail("/why")).toEqual([
      ["June", "https://june.build/"],
      ["Why June", "https://june.build/why"],
    ]);
  });

  test("keyboard access: every outline removal has a replacement focus indicator", async () => {
    const css = await Bun.file(join(ROOT, "app/global.css")).text();
    // selectors whose rule drops the outline — each needs a named stand-in indicator
    const suppressed = [...css.matchAll(/([^{}]+)\{[^}]*outline:\s*none/g)].map((m) => m[1]!.trim());
    const REPLACEMENTS: Record<string, RegExp> = {
      ".j-ask-input": /\.j-ask-form:focus-within\s*\{[^}]*box-shadow:[^};]*var\(--s-signal\)/,
    };
    expect(suppressed).toEqual(Object.keys(REPLACEMENTS)); // a new `outline: none` must be added here, with its indicator
    for (const indicator of Object.values(REPLACEMENTS)) expect(css).toMatch(indicator);
  });

  test("keyboard access: every table scroll box is a focusable, named region", async () => {
    const bench = await (await get("/benchmarks")).text();
    const benchBoxes = bench.match(/<div class="j-bench-scroll" tabindex="0" role="region" aria-label="[^"]+ benchmarks">/g) ?? [];
    expect(benchBoxes.length).toBeGreaterThan(0);
    expect(benchBoxes.length).toBe((bench.match(/<table/g) ?? []).length);

    // markdown-rendered tables (docs + blog share the wrapper)
    const doc = await (await get("/docs/agents-directory")).text();
    const docBoxes = doc.match(/<div class="j-table-scroll" tabindex="0" role="region" aria-label="Table"><table>/g) ?? [];
    expect(docBoxes.length).toBeGreaterThan(0);
    expect(docBoxes.length).toBe((doc.match(/<table/g) ?? []).length); // no bare table left unwrapped
  });

  test("the landing copy doesn't promise every action is an agent tool", async () => {
    const md = await (await get("/index.md")).text();
    expect(md).not.toMatch(/every `defineAction\(\)` is a UI action, an agent/);
    expect(md).toContain("Export one from `agent/tools/`"); // the real rule: exported into the agent
  });

  test("docs headings are linkable, and every in-page #link on every doc lands on an id", async () => {
    const connections = await (await get("/docs/agents-connections")).text();
    expect(connections).toContain('<h2 id="errors-and-the-report">');
    expect(connections).toContain('<a class="j-anchor" href="#errors-and-the-report" aria-label="Link to this section">#</a>');
    // "On this page" lists the h2/h3 headings by the same ids
    expect(connections).toContain('<nav class="j-toc" aria-label="On this page">');
    expect(connections).toContain('<a href="#errors-and-the-report">Errors and the report</a>');
    // agents get the structure in the .json projection
    const json = await (await get("/docs/agents-connections.json")).json();
    expect(json.headings).toContainEqual({ depth: 2, text: "Errors and the report", id: "errors-and-the-report" });

    const { DOCS } = await import("./app/_content");
    for (const d of DOCS) {
      const html = await (await get(`/docs/${d.slug}`)).text();
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
        expect(ids.has(target!), `/docs/${d.slug}: href="#${target}" has no matching id`).toBe(true);
      }
    }
  });

  test("/why has ONE source: the page, its .md, and get_page all come from content/pages/why.md", async () => {
    const authored = await Bun.file(join(ROOT, "content/pages/why.md")).text();
    expect(await (await get("/why.md")).text()).toBe(authored); // the authored bytes, verbatim

    // every section of the file is on the page, as a linkable heading — nothing hand-copied
    const html = await (await get("/why")).text();
    const sections = [...authored.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
    expect(sections.length).toBeGreaterThan(2);
    // compared as literal strings (no heading text is ever read as a regex): the page's h2s,
    // in order, are exactly the file's sections, each with the id June's slugger gives it
    const slug = createSlugger();
    const onPage = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<a class="j-anchor"/g)].map((m) => [m[1], m[2]]);
    expect(onPage).toEqual(sections.map((s) => [slug(s), s]));

    const res = await rpc({ method: "tools/call", params: { name: "get_page", arguments: { slug: "why" } } });
    expect(JSON.parse(res.result.content[0].text).markdown).toBe(authored);
  });

  test("each page gets its own templated title", async () => {
    expect(await (await get("/why")).text()).toContain("<title>Why June · June</title>");
    expect(await (await get("/benchmarks")).text()).toContain("<title>Benchmarks · June</title>");
    expect(await (await get("/")).text()).toContain(
      "<title>June — build agents into real apps</title>",
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
    const served = await (await get("/docs/getting-started.md")).text();
    const authored = await Bun.file(join(ROOT, "content/docs/getting-started.md")).text();
    expect(served).toBe(authored);
  });

  test("a numbered legacy slug 301s to the unnumbered doc, suffix kept", async () => {
    for (const [from, to] of [
      ["/docs/05-stability", "/docs/stability"],
      ["/docs/05-stability.md", "/docs/stability.md"],
      ["/docs/05-stability/", "/docs/stability"],
    ]) {
      const res = await get(from);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(to);
    }
    expect((await get("/docs/stability")).status).toBe(200);
  });

  test("Features section: grouped in the index, each page renders with a demo", async () => {
    const index = await (await get("/docs")).text();
    // the three-section information architecture
    expect(index).toContain("<h2>Get started</h2>");
    expect(index).toContain("<h2>Concepts</h2>");
    expect(index).toContain("<h2>Features</h2>");

    const indexMd = await (await get("/docs.md")).text();
    expect(indexMd).toContain("## Features");

    for (const slug of [
      "features-mcp",
      "features-llms-txt",
      "features-markdown",
      "features-og-image",
      "features-rsc",
      "features-app-router",
      "features-layouts",
      "features-islands",
      "features-navigation",
      "features-data",
      "features-web-standards",
      "features-runtime",
      "features-dx",
      "features-cli",
    ]) {
      const html = await (await get(`/docs/${slug}`)).text();
      expect(html).toContain('data-layout="docs"'); // nested under the docs sidebar
      // every feature page carries a runnable demo or code sample
      expect(html).toContain("<code");
    }

    // the Agents section: grouped between Concepts and Features, every page a code sample
    expect(index).toContain("<h2>Agents</h2>");
    expect(index.indexOf("<h2>Concepts</h2>")).toBeLessThan(index.indexOf("<h2>Agents</h2>"));
    expect(index.indexOf("<h2>Agents</h2>")).toBeLessThan(index.indexOf("<h2>Features</h2>"));
    for (const slug of [
      "agents-overview",
      "agents-directory",
      "agents-channels",
      "agents-connections",
      "agents-durable-turns",
      "agents-deploy",
    ]) {
      const html = await (await get(`/docs/${slug}`)).text();
      expect(html).toContain('data-layout="docs"');
      expect(html).toContain("<code");
    }

    // the sidebar shows the short nav label, not the full page title
    const anyDoc = await (await get("/docs/features-mcp")).text();
    expect(anyDoc).toContain(">MCP</a>");
    expect(anyDoc).toContain(">OG Image</a>");
    expect(anyDoc).toContain(">Data model</a>");

    // the verbatim guarantee features-markdown.md demos holds for itself
    const served = await (await get("/docs/features-markdown.md")).text();
    const authored = await Bun.file(join(ROOT, "content/docs/features-markdown.md")).text();
    expect(served).toBe(authored);
  });
});

describe("og:image route (app/_extra escape hatch)", () => {
  test("the dev host renders a real PNG; non-og paths fall through", async () => {
    // Same card as production: satori + resvg-js here, workers-og on workerd.
    // (Fetches a Google Fonts subset — the one network touch in this suite.)
    const og = await get("/og/2026-06-10-typesetting-cjk-at-the-edge.png");
    expect(og.status).toBe(200);
    expect(og.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await og.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    expect((await get("/why")).status).toBe(200); // _extra falls through cleanly
  }, 15_000); // cold Google-Fonts subset fetches can outlive the 5s default

  test("every page kind resolves a card and points at it from its HTML", async () => {
    // docs + core pages resolve cards too (not only posts)
    for (const slug of ["features-mcp", "why"]) {
      const res = await get(`/og/${slug}.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    }
    // and the pages advertise them — absolute via deploy.domain, sized, with the
    // site's X handle
    const why = await (await get("/why")).text();
    expect(why).toContain('<meta property="og:image" content="https://june.build/og/why.png"/>');
    expect(why).toContain('<meta property="og:image:width" content="1200"/>');
    expect(why).toContain('<meta property="og:image:height" content="630"/>');
    expect(why).toContain('<meta name="twitter:site" content="@junebuild"/>');
    expect(why).toContain('<meta name="theme-color" content="#07080a"/>');
    expect(await (await get("/docs/features-og-image")).text()).toContain(
      '<meta property="og:image" content="https://june.build/og/features-og-image.png"/>',
    );
    expect(await (await get("/blog/2026-06-12-built-in-og-image")).text()).toContain(
      '<meta property="og:image" content="https://june.build/og/2026-06-12-built-in-og-image.png"/>',
    );
  }, 15_000);
});

describe("og:image card options (app/og-options.ts)", () => {
  test("each page kind gets its card: label, markdown path, date", () => {
    const post = POSTS.find((p) => p.slug === "2026-06-10-typesetting-cjk-at-the-edge")!;
    expect(ogOptions(post.slug)).toEqual({
      title: String(post.data.title),
      path: `/blog/${post.slug}`,
      kind: "blog",
      date: String(post.data.date),
    });
    const doc = DOCS.find((d) => d.slug === "features-mcp")!;
    expect(ogOptions("features-mcp")).toEqual({ title: String(doc.data.title), path: "/docs/features-mcp", kind: "docs" });
    expect(ogOptions("why")).toEqual({ title: "Why June", path: "/why" }); // a page: no pill, no date
    expect(ogOptions("benchmarks")).toEqual({ title: "Benchmarks", path: "/benchmarks" });
  });

  test("home (and an unknown slug) is the hero line at /, never /index", () => {
    const home = { title: "Build agents into real apps.", path: "/" };
    expect(ogOptions("index")).toEqual(home);
    expect(ogOptions("no-such-page")).toEqual(home);
  });
});

describe("favicon (generated letter default)", () => {
  test("favicon answers as SVG with the site initial, plus PNG/ICO; pages link them", async () => {
    const svg = await get("/favicon.svg");
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svg.text()).toContain(">J</text>"); // June → J
    for (const [path, type] of [
      ["/favicon.ico", "image/x-icon"],
      ["/icon.png", "image/png"],
      ["/apple-touch-icon.png", "image/png"],
    ]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
    }
    const home = await (await get("/")).text();
    expect(home).toContain('<link rel="icon" href="/favicon.svg"');
    expect(home).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>');
  });
});

describe("agent surface", () => {
  test("llms.txt is a curated index: sections, descriptions, every doc, posts under Optional", async () => {
    const llms = await (await get("/llms.txt")).text();
    const sections = [...llms.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
    // When to use leads (before every other H2), then the framework block, pages, the
    // docs sidebar's sections in order, the tools, and Optional as the LAST H2
    expect(sections).toEqual([
      "When to use", "Framework (canonical names — do not guess)", "Pages", "Get started", "Concepts", "Agents", "Features",
      "Tools (MCP)", "Tools (WebMCP, in-browser)", "HTTP API", "Optional",
    ]);
    expect(llms).toContain(
      "- [Connections: where tools come from](http://june.build/docs/agents-connections.md): A connection is an agent's outbound edge",
    );
    const { DOCS, POSTS } = await import("./app/_content");
    for (const d of DOCS) expect(llms).toContain(`(http://june.build/docs/${d.slug}.md)`); // every doc, via its .md
    const optional = llms.slice(llms.indexOf("## Optional"));
    for (const p of POSTS) expect(optional).toContain(`/blog/${p.slug}.md`);
    expect(llms).not.toMatch(/\]\([^)]*\[/); // no link URL is an unfetchable [param] template

    // every listed page actually answers with markdown
    for (const [, url] of llms.matchAll(/\]\((http:\/\/june\.build[^)]+)\)/g)) {
      const res = await get(new URL(url!).pathname);
      expect(res.status, url).toBe(200);
      expect(res.headers.get("content-type"), url).toContain("text/markdown");
    }
  });

  test("llms.txt + sitemap + api-catalog resolve", async () => {
    const llms = await (await get("/llms.txt")).text();
    expect(llms).toContain("/why");
    expect((await get("/sitemap.xml")).status).toBe(200);
    expect((await get("/.well-known/api-catalog")).status).toBe(200);
  });

  test("the sitemap lists every doc and post, each with its frontmatter date as <lastmod>", async () => {
    const xml = await (await get("/sitemap.xml")).text();
    // pathname → its <lastmod> (undefined when the url carries none)
    const entries = new Map(
      [...xml.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)].map((m) => [
        new URL(m[1]!).pathname,
        m[2],
      ]),
    );
    const expected = [
      ...DOCS.map((d) => [`/docs/${d.slug}`, d.data.updated ?? d.data.date] as const),
      ...POSTS.map((p) => [`/blog/${p.slug}`, p.data.updated ?? p.data.date] as const),
    ];
    for (const [path, date] of expected) {
      expect(entries.has(path), path).toBe(true);
      expect(entries.get(path), path).toBe(date as string | undefined);
    }
  });

  test("/mcp lists the site tools", async () => {
    const res = await rpc({ method: "tools/list", params: {} });
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("search_site");
    expect(names).toContain("get_page");
    // get_page's contract names every page slug it accepts, so agents can pick one
    const { PAGES } = await import("./app/content");
    const getPage = res.result.tools.find((t: any) => t.name === "get_page");
    for (const p of PAGES) expect(getPage.description).toContain(p.slug);
    for (const slug of ["about", "contact", "privacy"]) {
      const r = await rpc({ method: "tools/call", params: { name: "get_page", arguments: { slug } } });
      expect(JSON.parse(r.result.content[0].text).slug).toBe(slug);
    }
  });

  test("the same tools over HTTP: /openapi.json + POST /api/<id>", async () => {
    const doc = (await (await get("/openapi.json")).json()) as { paths: Record<string, { post: { operationId: string } }> };
    expect(doc.paths["/api/search_site"]!.post.operationId).toBe("search_site");
    expect(doc.paths["/api/get_page"]!.post.operationId).toBe("get_page");

    const res = await app.fetch(
      new Request("http://june.build/api/search_site", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "cold start" }),
      }),
    );
    expect(res.status).toBe(200);
    const cards = (await res.json()) as Array<{ slug: string }>;
    expect(cards.some((c) => c.slug.includes("cold-start"))).toBe(true);
  });

  test("/api is the API root: an index of the tools, and JSON (never HTML) for a miss", async () => {
    const index = (await (await get("/api", { accept: "text/html" })).json()) as {
      openapi: string;
      actions: Array<{ id: string; path: string }>;
    };
    expect(index.openapi).toBe("http://june.build/openapi.json");
    expect(index.actions.map((a) => a.path).sort()).toEqual(["/api/get_page", "/api/search_site"]);
    const miss = await get("/api/v1", { accept: "text/html" });
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("a malformed percent-escape is a 404, never a crash (the dev resolver decodes segments)", async () => {
    const page = await get("/docs/%ZZ", { accept: "text/html" });
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toContain("text/html");
    for (const method of ["GET", "POST"]) {
      const res = await app.fetch(
        new Request("http://june.build/api/%ZZ", {
          method,
          headers: { accept: "text/html", "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );
      expect(res.status, method).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
    // a valid escape still resolves ("%2D" is "-")
    expect((await get("/docs/agents%2Doverview", { accept: "text/html" })).status).toBe(200);
  });

  test("WebMCP: pages inject the tool manifest + registration bridge", async () => {
    const html = await (await get("/")).text();
    // the manifest the browser script reads — same tools as /mcp
    expect(html).toContain('<script type="application/json" id="june-webmcp">');
    expect(html).toContain("search_site");
    // the registration bridge to navigator.modelContext
    expect(html).toContain("navigator.modelContext");
    expect(html).toContain("registerTool");
  });

  test("search_site splits queries on punctuation, in any script", async () => {
    const search = async (query: string) => {
      const res = await rpc({ method: "tools/call", params: { name: "search_site", arguments: { query } } });
      return JSON.parse(res.result.content[0].text) as Array<{ slug: string }>;
    };
    // sentence punctuation stays off the term: "slack?" searches for "slack"
    expect((await search("slack?")).some((c) => c.slug === "docs/agents-channels")).toBe(true);
    expect((await search("cold-start")).some((c) => c.slug.includes("cold-start"))).toBe(true);
    // letters in any script are terms (the CJK post's title carries 排版)
    expect((await search("排版?")).some((c) => c.slug.includes("typesetting-cjk"))).toBe(true);
    // nothing but punctuation → no terms → no results, not everything
    expect(await search("?!")).toEqual([]);
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
    expect(why.markdown).toContain("## Vision");
  });
});
