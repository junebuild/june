// Agent-readiness hygiene on the render pipeline: a 404 an agent can act on, the
// markdown twin advertised from the HTML, and markdown that opens with the page's
// metadata. (Vary on prerendered assets is withAssets' job — with-assets.test.ts.)

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { resolveAgent } from "@junejs/core/config";
import { type DocumentConfig } from "@junejs/core/document";
import { route } from "@junejs/core/route";

import { createApp } from "../src/app";
import { createPipeline, htmlPath, markdownPath, type RouteResolver } from "../src/pipeline";

const APP_DIR = fileURLToPath(new URL("../../../examples/basic/app", import.meta.url));
const site = { name: "June Basic", description: "Fixture app.", url: "https://basic.example" };
const app = createApp({ appDir: APP_DIR, config: { site } });
const get = (path: string, headers?: Record<string, string>) => app.fetch(new Request(`http://x${path}`, { headers }));

describe("agent-friendly 404", () => {
  test("Accept: text/markdown → a Markdown 404 pointing at the discovery surfaces", async () => {
    const res = await get("/no-such-page", { accept: "text/markdown" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("vary")).toBe("accept");
    const body = await res.text();
    expect(body).toStartWith("# 404 — Not found");
    expect(body).toContain("`/no-such-page`");
    expect(body).toContain("(/llms.txt)");
    expect(body).toContain("(/sitemap.xml)");
    expect(body).toContain("(/mcp)");
  });

  test("a .md URL with no page → the same Markdown 404", async () => {
    const res = await get("/no-such-page.md");
    expect(res.status).toBe(404);
    expect(await res.text()).toStartWith("# 404 — Not found");
  });

  test("JSON 404 keeps error/path and adds a code + hint", async () => {
    const res = await get("/no-such-page", { accept: "application/json" });
    expect(res.status).toBe(404);
    expect(res.headers.get("vary")).toBe("accept");
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("Not Found");
    expect(body.path).toBe("/no-such-page");
    expect(body.code).toBe("not_found");
    expect(body.hint).toContain("/llms.txt");
  });

  test("the HTML 404 document is unchanged for browsers, plus Vary", async () => {
    const res = await get("/no-such-page");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("vary")).toBe("accept");
    expect(await res.text()).toContain("404 — Not found");
  });

  // A pipeline with only the routes given: "/" is present iff `home` is.
  const bare = (home?: ReturnType<typeof route>) => {
    const docConfig: DocumentConfig = {
      site: { name: "T" },
      speculationRules: null,
      speculationDelivery: "inline",
      viewTransitions: false,
    };
    const resolve: RouteResolver = async (p) => (p === "/" && home ? { def: home, params: {}, chain: [] } : null);
    return createPipeline({ docConfig, agent: resolveAgent(undefined), routeList: () => [], resolve });
  };

  test("no root route → the 404 does not point at a /index.md that 404s too", async () => {
    const body = await (await bare().fetch(new Request("http://x/nope.md"))).text();
    expect(body).toContain("(/llms.txt)");
    expect(body).not.toContain("/index.md");
  });

  test("a root route with md = false → no /index.md link (Markdown or JSON)", async () => {
    const p = bare(route({ md: false }));
    expect(await (await p.fetch(new Request("http://x/nope.md"))).text()).not.toContain("/index.md");
    const json = (await (await p.fetch(new Request("http://x/nope.json"))).json()) as { hint: string };
    expect(json.hint).not.toContain("/index.md");
  });

  test("with the agent surface off, the Markdown 404 lists no dead discovery links", async () => {
    const off = createApp({ appDir: APP_DIR, config: { site, agent: { enabled: false } } });
    const body = await (await off.fetch(new Request("http://x/nope.md"))).text();
    expect(body).not.toContain("/llms.txt");
    expect(body).not.toContain("/mcp");
    expect(body).toContain("(/index.md)");
  });
});

describe("markdown twin advertised from the HTML", () => {
  test("home links /index.md, a page links <path>.md", async () => {
    expect(await (await get("/")).text()).toContain('<link rel="alternate" type="text/markdown" href="/index.md"/>');
    expect(await (await get("/users")).text()).toContain('<link rel="alternate" type="text/markdown" href="/users.md"/>');
  });

  test("the advertised href really serves markdown", async () => {
    const res = await get("/users.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
  });

  test("discovery off → no markdown alternate", async () => {
    const off = createApp({ appDir: APP_DIR, config: { site, agent: { enabled: false } } });
    expect(await (await off.fetch(new Request("http://x/"))).text()).not.toContain('type="text/markdown"');
  });

  test("markdownPath mirrors the prerendered file names", () => {
    expect(markdownPath("/", true)).toBe("/index.md");
    expect(markdownPath("/index", true)).toBe("/index.md");
    expect(markdownPath("/zh-cn", true)).toBe("/zh-cn/index.md");
    expect(markdownPath("/docs/intro", false)).toBe("/docs/intro.md");
    // a trailing slash is the same page — its twin is flat, never <path>/index.md
    expect(markdownPath("/users/", false)).toBe("/users.md");
    expect(markdownPath("/zh-cn/", true)).toBe("/zh-cn/index.md");
    // a locale home via its /index alias is the same home, not /de/index/index.md
    expect(markdownPath("/de/index", true)).toBe("/de/index.md");
    // a non-home /docs/index is its own route
    expect(markdownPath("/docs/index", false)).toBe("/docs/index.md");
  });

  test("htmlPath folds /index only for a home", () => {
    expect(htmlPath("/index.md", true)).toBe("/");
    expect(htmlPath("/de/index.md", true)).toBe("/de");
    expect(htmlPath("/de/index", true)).toBe("/de");
    expect(htmlPath("/docs/x.md", false)).toBe("/docs/x");
    expect(htmlPath("/docs/index.md", false)).toBe("/docs/index");
  });

  describe("under i18n", () => {
    const docConfig: DocumentConfig = {
      site: { name: "T", url: "https://t.example" },
      speculationRules: null,
      speculationDelivery: "inline",
      viewTransitions: false,
    };
    const resolve: RouteResolver = async (p) =>
      p === "/" || p === "/docs/index" ? { def: route({ metadata: { title: p } }), params: {}, chain: [] } : null;
    const p = createPipeline({
      docConfig,
      agent: resolveAgent(undefined),
      i18n: { defaultLocale: "en", locales: { en: {}, de: { path: "/de" } } },
      routeList: () => [],
      resolve,
    });
    const fetchText = async (path: string, headers?: Record<string, string>) =>
      (await p.fetch(new Request(`https://t.example${path}`, { headers }))).text();

    test("a locale home's /index alias advertises /de/index.md", async () => {
      expect(await fetchText("/de/index")).toContain('type="text/markdown" href="/de/index.md"');
      expect(await fetchText("/de")).toContain('type="text/markdown" href="/de/index.md"');
    });

    test("the locale home's markdown canonical is /de, however it was requested", async () => {
      for (const [path, headers] of [["/de/index.md"], ["/de/index", { accept: "text/markdown" }]] as const) {
        expect(await fetchText(path, headers)).toContain('\ncanonical: "https://t.example/de"\n');
      }
    });

    test("a non-home /docs/index keeps its own canonical", async () => {
      expect(await fetchText("/docs/index.md")).toContain('\ncanonical: "https://t.example/docs/index"\n');
    });
  });
});

describe("Vary: Accept on every pipeline document", () => {
  test("a streamed page (loading.tsx) varies on Accept like any other view", async () => {
    const res = await get("/slow");
    expect(res.status).toBe(200);
    expect(res.headers.get("vary")).toBe("accept");
  });
});

describe("markdown frontmatter", () => {
  // The page's own title, like authored frontmatter — not the "%s · Site" tab title.
  test("title is the page title, not the templated <title>", async () => {
    const templated = createApp({ appDir: APP_DIR, config: { site: { ...site, titleTemplate: "%s · June Basic" } } });
    const body = await (await templated.fetch(new Request("http://x/users.md"))).text();
    expect(body).toStartWith('---\ntitle: "Users"\n');
  });

  test("an empty metadata title falls back to the site name, like documentTitle()", async () => {
    const docConfig: DocumentConfig = {
      site: { name: "Site Name", titleTemplate: "%s · Site Name" },
      speculationRules: null,
      speculationDelivery: "inline",
      viewTransitions: false,
    };
    const resolve: RouteResolver = async (p) =>
      p === "/blank" ? { def: route({ metadata: { title: "" } }), params: {}, chain: [] } : null;
    const p = createPipeline({ docConfig, agent: resolveAgent(undefined), routeList: () => [], resolve });
    const body = await (await p.fetch(new Request("http://x/blank.md"))).text();
    expect(body).toStartWith('---\ntitle: "Site Name"\n');
  });

  test("served markdown opens with title / description / canonical", async () => {
    const body = await (await get("/users.md")).text();
    expect(body).toStartWith("---\ntitle: ");
    expect(body).toContain('\ncanonical: "https://basic.example/users"\n');
    expect(body).toMatch(/\ndescription: ".+"\n/);
    // the page's own content follows the block
    expect(body.split("\n---\n")[1]!.length).toBeGreaterThan(0);
  });

  test("the home projection's canonical is the site root, not /index", async () => {
    const body = await (await get("/index.md")).text();
    expect(body).toContain('\ncanonical: "https://basic.example/"\n');
  });

  test("Accept-negotiated markdown carries the same block", async () => {
    const body = await (await get("/users", { accept: "text/markdown" })).text();
    expect(body).toContain('\ncanonical: "https://basic.example/users"\n');
  });
});
