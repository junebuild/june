// BreadcrumbList JSON-LD: every non-home page places itself in the site. The
// trail is derived from the URL — but only through ancestors that are pages by
// declaration (resolved with no params); a dynamic match or a path that resolves
// to nothing is skipped, never guessed. Metadata.breadcrumb overrides or opts out.

import { describe, expect, test } from "bun:test";
import React from "react";

import { resolveAgent } from "@junejs/core/config";
import { type DocumentConfig } from "@junejs/core/document";
import { route, type Metadata } from "@junejs/core/route";

import { createPipeline, type RouteResolver } from "../src/pipeline";

const view = () => React.createElement("p", null, "hi");
const page = (metadata?: Metadata | ((d: unknown) => Metadata), params: Record<string, string> = {}) => ({
  def: route({ view, ...(metadata ? { metadata } : {}) } as never),
  params,
  chain: [],
});

// The app's route table, as a resolver sees it.
const resolve: RouteResolver = async (pathname) => {
  switch (pathname) {
    case "/docs":
      return page({ title: "Documentation" }); // static page, static title
    case "/docs/guides":
      return null; // not a page: no crumb for it
    case "/docs/guides/intro":
      return page({ title: "Introduction" });
    case "/blog":
      return page(() => ({ title: "From data" })); // a page whose title needs a load
    case "/blog/2026":
      return page({ title: "Year" }, { slug: "2026" }); // a dynamic match: exists only if its data does
    case "/blog/2026/hello-world":
      return page(() => ({ title: "Hello, world" }), { slug: "hello-world" });
    case "/api":
      return { handler: () => new Response("ok"), params: {} }; // a resource route, not a page
    case "/api/status-page":
      return page({ title: "Status" });
    case "/shop/shoes":
      return page({
        title: "Shoes",
        breadcrumb: [
          { name: "Catalog", path: "/c" },
          { name: "Shoes", path: "/shop/shoes" },
        ],
      });
    case "/about/team":
      return page({ title: "Team", breadcrumb: false });
    case "/drafts/wip":
      return page({ title: "WIP", robots: "noindex" });
    case "/slow":
      return null;
    case "/slow/page":
      return { ...page({ title: "Slow" }), loading: () => React.createElement("i", null, "…") };
    case "/":
      return page({ title: "Home" });
    default:
      return page();
  }
};

function pipeline(doc: Partial<DocumentConfig> = {}) {
  const docConfig: DocumentConfig = {
    site: { name: "Acme — tools for builders", url: "https://acme.example" },
    speculationRules: null,
    speculationDelivery: "inline",
    viewTransitions: false,
    ...doc,
  };
  const p = createPipeline({ docConfig, agent: resolveAgent(undefined), routeList: () => [], resolve });
  return async (path: string) => (await p.fetch(new Request(`https://acme.example${path}`))).text();
}

type Item = { position: number; name: string; item: string };
const trail = (html: string): Item[] | undefined => {
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) {
    const node = JSON.parse(json!)["@graph"].find((n: { "@type": string }) => n["@type"] === "BreadcrumbList");
    if (node) return node.itemListElement;
  }
  return undefined;
};
const pairs = (items: Item[] | undefined) => items?.map((i) => [i.name, i.item]);

describe("BreadcrumbList JSON-LD", () => {
  const get = pipeline();

  test("home first (the site's short name), then page ancestors by static title, then the page", async () => {
    const items = trail(await get("/docs/guides/intro"))!;
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(pairs(items)).toEqual([
      ["Acme", "https://acme.example/"],
      ["Documentation", "https://acme.example/docs"],
      // /docs/guides resolves to nothing — skipped, not invented
      ["Introduction", "https://acme.example/docs/guides/intro"],
    ]);
  });

  test("an ancestor without a static title is labelled by its URL segment; a dynamic match is skipped", async () => {
    expect(pairs(trail(await get("/blog/2026/hello-world")))).toEqual([
      ["Acme", "https://acme.example/"],
      ["Blog", "https://acme.example/blog"], // real page, title needs data → humanized segment
      // /blog/2026 is a dynamic match (params) — its existence is data, so no crumb
      ["Hello, world", "https://acme.example/blog/2026/hello-world"], // the page's own resolved title
    ]);
  });

  test("a resource route is not a page, so it is never a crumb", async () => {
    expect(pairs(trail(await get("/api/status-page")))).toEqual([
      ["Acme", "https://acme.example/"],
      ["Status", "https://acme.example/api/status-page"],
    ]);
  });

  test("a page without a title is labelled by its humanized segment", async () => {
    expect(pairs(trail(await get("/getting-started")))).toEqual([
      ["Acme", "https://acme.example/"],
      ["Getting started", "https://acme.example/getting-started"],
    ]);
  });

  test("metadata.breadcrumb overrides the derived trail (home is still first)", async () => {
    expect(pairs(trail(await get("/shop/shoes")))).toEqual([
      ["Acme", "https://acme.example/"],
      ["Catalog", "https://acme.example/c"],
      ["Shoes", "https://acme.example/shop/shoes"],
    ]);
  });

  test("metadata.breadcrumb: false opts out", async () => {
    expect(trail(await get("/about/team"))).toBeUndefined();
  });

  test("the home page has no breadcrumb (its JSON-LD is the WebSite)", async () => {
    const html = await get("/");
    expect(trail(html)).toBeUndefined();
    expect(html).toContain(`"@type":"WebSite"`);
  });

  test("a noindex page gets none (same gate as its canonical)", async () => {
    expect(trail(await get("/drafts/wip"))).toBeUndefined();
  });

  test("a streamed page (loading.tsx) carries its trail too", async () => {
    expect(pairs(trail(await get("/slow/page")))).toEqual([
      ["Acme", "https://acme.example/"],
      ["Slow", "https://acme.example/slow/page"],
    ]);
  });

  test("no public origin → no breadcrumb (it needs absolute URLs)", async () => {
    const noOrigin = createPipeline({
      docConfig: { site: { name: "Acme" }, speculationRules: null, speculationDelivery: "inline", viewTransitions: false },
      agent: resolveAgent(undefined),
      routeList: () => [],
      resolve,
    });
    const html = await (await noOrigin.fetch(new Request("https://prerender.june/docs/guides/intro"))).text();
    expect(trail(html)).toBeUndefined();
  });

  test("under a deploy basePath, every item URL carries it", async () => {
    const based = pipeline({ basePath: "/base" });
    expect(pairs(trail(await based("/docs/guides/intro")))).toEqual([
      ["Acme", "https://acme.example/base/"],
      ["Documentation", "https://acme.example/base/docs"],
      ["Introduction", "https://acme.example/base/docs/guides/intro"],
    ]);
  });

  // The trail is resolved BEFORE a streamed page's load() starts: an await between
  // starting the load and React taking the promise would leave a load that rejects
  // meanwhile unhandled (fatal on a Node host with --unhandled-rejections=throw).
  test("a streamed page whose load rejects during slow ancestor resolution is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const slow: RouteResolver = async (pathname) => {
        if (pathname === "/a/b")
          return {
            def: route({ metadata: { title: "B" }, load: () => Promise.reject(new Error("load failed")), view } as never),
            params: {},
            chain: [],
            loading: () => React.createElement("i", null, "…"),
          };
        await new Promise((r) => setTimeout(r, 30)); // a slow ancestor resolve
        return null;
      };
      const p = createPipeline({
        docConfig: {
          site: { name: "Acme", url: "https://acme.example" },
          speculationRules: null,
          speculationDelivery: "inline",
          viewTransitions: false,
        },
        agent: resolveAgent(undefined),
        routeList: () => [],
        resolve: slow,
      });
      const quiet = console.error;
      console.error = () => {}; // React reports the (handled) load failure via onError
      try {
        const res = await p.fetch(new Request("https://acme.example/a/b"));
        await res.text().catch(() => {});
        await new Promise((r) => setTimeout(r, 20));
      } finally {
        console.error = quiet;
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
