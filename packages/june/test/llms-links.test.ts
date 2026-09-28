// collectLlmsLinks — each route's `llms` export → /llms.txt links. A fake resolver
// hands back route definitions by pathname, so every rule is exercised in isolation.
import { describe, expect, test } from "bun:test";

import { route, type BrandedRoute } from "@junejs/core/route";
import { collectLlmsLinks, collectSitemapPages } from "../src/llms-links";
import type { RouteResolver } from "../src/pipeline";

const ORIGIN = "https://site.test";
const resolverOf = (defs: Record<string, BrandedRoute>): RouteResolver => async (p) =>
  defs[p] ? { def: defs[p]!, params: {}, chain: [] } : null;
const view = () => null;

describe("collectLlmsLinks", () => {
  test("a static route with no llms export → one 'Pages' link from its static metadata", async () => {
    const links = await collectLlmsLinks(ORIGIN, ["/about"], resolverOf({
      "/about": route({ view, metadata: { title: "About us", description: "Who we are." } }),
    }));
    expect(links).toEqual([
      { title: "About us", url: `${ORIGIN}/about.md`, description: "Who we are.", section: "Pages", optional: false },
    ]);
  });

  test('"/" links /index.md; a metadata FUNCTION (needs data) falls back to the path as title', async () => {
    const links = await collectLlmsLinks(ORIGIN, ["/", "/live"], resolverOf({
      "/": route({ view, metadata: { title: "Home" } }),
      "/live": route({ view, metadata: () => ({ title: "computed" }) }),
    }));
    expect(links.map((l) => [l.title, l.url])).toEqual([
      ["Home", `${ORIGIN}/index.md`],
      ["/live", `${ORIGIN}/live.md`],
    ]);
  });

  test("a static route can set its section, description, and optional flag", async () => {
    const links = await collectLlmsLinks(ORIGIN, ["/changelog"], resolverOf({
      "/changelog": route({ view, metadata: { title: "Changelog" }, llms: { section: "Project", optional: true } }),
    }));
    expect(links).toEqual([
      { title: "Changelog", url: `${ORIGIN}/changelog.md`, description: undefined, section: "Project", optional: true },
    ]);
  });

  test("a dynamic template is skipped unless it lists its real pages", async () => {
    const pages = [
      { path: "/docs/intro", title: "Intro", description: "Start.", section: "Get started" },
      { path: "/docs/auth", title: "Auth", section: "Concepts" },
    ];
    const links = await collectLlmsLinks(ORIGIN, ["/docs/[slug]", "/posts/[slug]"], resolverOf({
      "/docs/[slug]": route({ view, llms: async () => pages }), // may be async
      "/posts/[slug]": route({ view }), //                         no llms → not listed
    }));
    expect(links).toEqual([
      { title: "Intro", url: `${ORIGIN}/docs/intro.md`, description: "Start.", section: "Get started", optional: false },
      { title: "Auth", url: `${ORIGIN}/docs/auth.md`, description: undefined, section: "Concepts", optional: false },
    ]);
  });

  test("a dynamic entry without a path is dropped (there is no page to link)", async () => {
    const links = await collectLlmsLinks(ORIGIN, ["/x/[id]"], resolverOf({
      "/x/[id]": route({ view, llms: [{ title: "no path" }] }),
    }));
    expect(links).toEqual([]);
  });

  test("llms: false drops a route; md: false links the page itself; resource routes are skipped", async () => {
    const resolve: RouteResolver = async (p) =>
      p === "/rss"
        ? { handler: async () => new Response(""), params: {} } // a resource route
        : resolverOf({
            "/admin": route({ view, llms: false }),
            "/raw": route({ view, md: false, metadata: { title: "Raw" } }),
          })(p);
    const links = await collectLlmsLinks(ORIGIN, ["/admin", "/raw", "/rss"], resolve);
    expect(links.map((l) => l.url)).toEqual([`${ORIGIN}/raw`]);
  });

  test("paths that render the same URL (/a and /a/ → /a.md) are one page", async () => {
    const links = await collectLlmsLinks(ORIGIN, ["/x/[s]"], resolverOf({
      "/x/[s]": route({ view, llms: [{ path: "/a", title: "A" }, { path: "/a/", title: "A slash" }] }),
    }));
    expect(links.map((l) => [l.title, l.url])).toEqual([["A", `${ORIGIN}/a.md`]]);
  });

  test("the same page listed twice (e.g. by two routes) appears once", async () => {
    const links = await collectLlmsLinks(ORIGIN, ["/a", "/b/[s]"], resolverOf({
      "/a": route({ view, metadata: { title: "A" } }),
      "/b/[s]": route({ view, llms: [{ path: "/a", title: "A again" }] }),
    }));
    expect(links.map((l) => l.title)).toEqual(["A"]);
  });
});

describe("collectSitemapPages", () => {
  const docs = () =>
    resolverOf({
      "/": route({ view }),
      "/docs/[slug]": route({
        view,
        llms: [{ path: "/docs/intro", lastModified: "2026-06-12" }],
        // the static() producer hands over every locale × slug, already prefixed
        staticPaths: ["/docs/intro", "/docs/extra", "/de/docs/intro"],
      }),
    });

  test("runtime (the default): dynamic pages come from llms entries only; staticPaths never run", async () => {
    let ran = false;
    const resolve = resolverOf({
      "/docs/[slug]": route({
        view,
        llms: [{ path: "/docs/intro" }],
        staticPaths: () => {
          ran = true;
          return ["/docs/extra"];
        },
      }),
    });
    expect(await collectSitemapPages(["/docs/[slug]"], resolve)).toEqual([{ path: "/docs/intro" }]);
    expect(ran).toBe(false);
  });

  test("llms = false keeps a static route; on a dynamic route it drops its pages at runtime (static build: staticPaths)", async () => {
    const resolve = resolverOf({
      "/about": route({ view, llms: false }),
      "/notes/[id]": route({ view, llms: false, staticPaths: ["/notes/1"] }),
    });
    const routes = ["/about", "/notes/[id]"];
    expect(await collectSitemapPages(routes, resolve)).toEqual([{ path: "/about" }]);
    expect(await collectSitemapPages(routes, resolve, { staticPaths: true })).toEqual([
      { path: "/about" },
      { path: "/notes/1" },
    ]);
  });

  test("static build: staticPaths join the llms pages, deduped", async () => {
    const pages = await collectSitemapPages(["/", "/docs/[slug]"], docs(), { staticPaths: true });
    expect(pages).toEqual([
      { path: "/" },
      { path: "/docs/intro", lastModified: "2026-06-12" },
      { path: "/docs/extra" },
      { path: "/de/docs/intro" },
    ]);
  });

  test("static build with i18n: locale-prefixed staticPaths are skipped; canonical llms pages stay", async () => {
    const pages = await collectSitemapPages(["/", "/docs/[slug]"], docs(), { staticPaths: true, i18n: true });
    expect(pages.map((p) => p.path)).toEqual(["/", "/docs/intro"]);
  });
});
