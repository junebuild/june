// Route precedence is part of the dev ≡ built-worker contract (#312). `june dev`
// resolves with matchRouteTree's per-segment ranking (static > [param] >
// [...catchAll], required before optional, app/ before .june/routes/); the built
// worker must pick the SAME route for every path — whether the winner is a page
// or a resource route. Before #312 the worker tried static pages, then dynamic
// pages, then resource routes, so `[slug]/page.tsx` answered /feed.xml ahead of
// `feed.xml/route.ts` and a root `[[...slug]]` swallowed `/og/*`.
//
// Fixtures live UNDER the package so their JSX resolves June's configured jsx
// runtime, and are written at test time because `.june/` is gitignored.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { juneBuild } from "../src/build";
import { buildManifest } from "../src/manifest";
import { createWorker } from "../src/worker";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://june.test";
const tmps: string[] = [];
afterAll(() => tmps.forEach((t) => rmSync(t, { recursive: true, force: true })));

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(PKG_DIR, ".tmp-prec-"));
  tmps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

// A page that prints its marker and the named param, so the body says which
// route answered and what it captured.
const page = (marker: string, param?: string) =>
  param
    ? `export const loader = (ctx) => ({ v: ctx.params[${JSON.stringify(param)}] ?? "-" });\n` +
      `export default function P({ v }) { return <main>{${JSON.stringify(marker + ":")} + v}</main>; }\n`
    : `export default function P() { return <main>${marker}</main>; }\n`;

const resource = (marker: string, param?: string) =>
  `export default function h(_req, ctx) {\n` +
  `  return new Response(${JSON.stringify(marker)}${param ? ` + ":" + ctx.params[${JSON.stringify(param)}]` : ""},` +
  ` { headers: { "content-type": "text/plain; charset=utf-8" } });\n}\n`;

type Fetcher = { fetch(r: Request): Promise<Response> };

// Resolve `path` in dev and on the worker and assert they agree, then that the
// winner is `expected` (a substring of the body). The worker is the in-process
// one (createWorker over buildManifest) unless `bundle` is set: then it is the
// worker `juneBuild` EMITS, so the code-generated manifest (generatedRoutes
// included) is what's under test, not the in-process object.
async function expectBoth(
  root: string,
  cases: Array<[path: string, expected: string]>,
  opts: { bundle?: boolean } = {},
) {
  const dev = createApp({ appDir: join(root, "app") });
  let worker: Fetcher;
  if (opts.bundle) {
    const { outFile } = await juneBuild(root);
    worker = ((await import(outFile)) as { default: Fetcher }).default;
  } else {
    worker = createWorker(await buildManifest(root));
  }
  for (const [path, expected] of cases) {
    const [d, w] = await Promise.all([
      dev.fetch(new Request(ORIGIN + path)),
      worker.fetch(new Request(ORIGIN + path)),
    ]);
    const [db, wb] = await Promise.all([d.text(), w.text()]);
    expect({ path, status: w.status, type: w.headers.get("content-type") }).toEqual({
      path,
      status: d.status,
      type: d.headers.get("content-type"),
    });
    expect({ path, body: wb }).toEqual({ path, body: db });
    expect({ path, status: d.status, hit: db.includes(expected) }).toEqual({ path, status: 200, hit: true });
  }
}

describe("route precedence: dev ≡ built worker (#312)", () => {
  test("a static resource route beats a dynamic page; a root [[...slug]] does not swallow [slug]", async () => {
    const root = fixture({
      "app/page.tsx": page("home"),
      "app/[slug]/page.tsx": page("slug", "slug"),
      "app/[[...rest]]/page.tsx": page("rest", "rest"),
      "app/feed.xml/route.ts": resource("rss"),
    });
    await expectBoth(root, [
      ["/", "home"],
      ["/feed.xml", "rss"],
      ["/hello", "slug:hello"],
      ["/a/b", "rest:a/b"],
    ]);
  });

  test("segment shape decides, not route kind: a [param] resource beats a catch-all page", async () => {
    const root = fixture({
      "app/api/[id]/route.ts": resource("api-id", "id"),
      "app/api/[...all]/page.tsx": page("api-all", "all"),
    });
    await expectBoth(root, [
      ["/api/7", "api-id:7"],
      ["/api/7/8", "api-all:7/8"],
    ]);
  });

  test("a page and a resource route at the same path: the page wins", async () => {
    const root = fixture({
      "app/both/page.tsx": page("both-page"),
      "app/both/route.ts": resource("both-route"),
    });
    await expectBoth(root, [["/both", "both-page"]]);
  });

  test("required before optional, and a route that ends here before an absent optional", async () => {
    const root = fixture({
      "app/p/[[opt]]/page.tsx": page("p-opt", "opt"),
      "app/p/[req]/page.tsx": page("p-req", "req"),
      "app/docs/page.tsx": page("docs-index"),
      "app/docs/[[...path]]/page.tsx": page("docs-path", "path"),
    });
    await expectBoth(root, [
      ["/p", "p-opt:-"],
      ["/p/x", "p-req:x"],
      ["/docs", "docs-index"],
      ["/docs/a/b", "docs-path:a/b"],
    ]);
  });

  test("a deeper mismatch falls back to the next-ranked route (dev backtracks)", async () => {
    const root = fixture({
      "app/x/[a]/c/page.tsx": page("a-c", "a"),
      "app/[slug]/page.tsx": page("slug", "slug"),
      "app/[[...rest]]/page.tsx": page("rest", "rest"),
    });
    await expectBoth(root, [
      ["/x/v/c", "a-c:v"],
      ["/x/v/d", "rest:x/v/d"],
      ["/x", "slug:x"],
    ]);
  });

  test("Kura shape: .june/routes/ [[...slug]] next to its own og/[slug] and an app feed.xml", async () => {
    const root = fixture({
      "app/page.tsx": page("home"),
      "app/feed.xml/route.ts": resource("rss"),
      "app/changelog/[slug]/page.tsx": page("entry", "slug"),
      ".june/routes/[[...slug]]/page.tsx": page("kura-doc", "slug"),
      ".june/routes/og/[slug]/route.ts": resource("og", "slug"),
      ".june/routes/search/page.tsx": page("kura-search"),
    });
    await expectBoth(root, [
      ["/", "home"],
      ["/feed.xml", "rss"],
      ["/og/intro", "og:intro"],
      ["/search", "kura-search"],
      ["/guide/intro", "kura-doc:guide/intro"],
      ["/changelog/v1", "entry:v1"],
    ]);
  });

  // #314: dev tried every (group) dir before the static sibling, so a grouped
  // [slug] answered /about. A group is invisible in the URL, so its children
  // rank as siblings of the level it sits in.
  test("route groups are transparent to ranking: a grouped [slug] does not shadow a static sibling", async () => {
    const root = fixture({
      "app/(g)/[slug]/page.tsx": page("group-slug", "slug"),
      "app/about/page.tsx": page("about"),
      // the static side inside a group, the dynamic side outside it
      "app/[section]/page.tsx": page("section", "section"),
      "app/(marketing)/pricing/page.tsx": page("pricing"),
      // nested groups, and a catch-all that must still lose to a grouped [param]
      "app/docs/(a)/(b)/[page]/page.tsx": page("docs-page", "page"),
      "app/docs/[...rest]/page.tsx": page("docs-rest", "rest"),
      // a page at a group's root answers the level itself
      "app/shop/(store)/page.tsx": page("shop-home"),
      "app/shop/[[...filters]]/page.tsx": page("shop-filters", "filters"),
    });
    await expectBoth(root, [
      ["/about", "about"],
      ["/pricing", "pricing"],
      // (g)/[slug] and [section] tie on rank; the name decides, group or not
      ["/x", "section:x"],
      ["/docs/intro", "docs-page:intro"],
      ["/docs/a/b", "docs-rest:a/b"],
      ["/shop", "shop-home"],
      ["/shop/red", "shop-filters:red"],
    ]);
  });

  test("a group's layout stays in the chain when its child wins by rank", async () => {
    const root = fixture({
      "app/(site)/layout.tsx":
        "export default function L({ children }) { return <div data-group=\"site\">{children}</div>; }\n",
      "app/(site)/about/page.tsx": page("about"),
      "app/[slug]/page.tsx": page("slug", "slug"),
    });
    await expectBoth(root, [
      ["/about", 'data-group="site"'],
      ["/x", "slug:x"],
    ]);
  });

  test("a bracketed name that is not a param is a static segment, matched literally", async () => {
    const root = fixture({
      // createWorker compiled `docs[v2` into an unterminated character class and threw.
      "app/docs[v2/page.tsx": page("docs-v2"),
      // `[slug].png` must not become the character class [slug] + ".png".
      "app/og/[slug].png/page.tsx": page("literal-png"),
      "app/og/[name]/page.tsx": page("og-name", "name"),
      // `[1]` is not an identifier: static in dev, so [slug] answers /x.
      "app/[1]/page.tsx": page("one"),
      "app/[slug]/page.tsx": page("slug", "slug"),
    });
    await expectBoth(root, [
      ["/docs[v2", "docs-v2"],
      ["/og/[slug].png", "literal-png"],
      ["/og/s.png", "og-name:s.png"],
      ["/x", "slug:x"],
      ["/[1]", "one"],
    ]);
  });

  test("app/ is consulted before .june/routes/, as in dev: an app [slug] answers before a generated static page", async () => {
    const root = fixture({
      "app/[slug]/page.tsx": page("app-slug", "slug"),
      ".june/routes/search/page.tsx": page("kura-search"),
      ".june/routes/og/[slug]/route.ts": resource("og", "slug"),
    });
    await expectBoth(root, [
      ["/search", "app-slug:search"],
      ["/og/intro", "og:intro"],
    ]);
  });

  // The two cases above run the in-process manifest. Production runs the entry
  // build.ts GENERATES, whose generatedRoutes field is emitted separately: drop
  // or garble it there and only this test notices.
  test("the emitted worker bundle carries the same precedence (generatedRoutes codegen)", async () => {
    const root = fixture({
      "app/[slug]/page.tsx": page("app-slug", "slug"),
      "app/feed.xml/route.ts": resource("rss"),
      ".june/routes/search/page.tsx": page("kura-search"),
      ".june/routes/[[...doc]]/page.tsx": page("kura-doc", "doc"),
      ".june/routes/og/[slug]/route.ts": resource("og", "slug"),
    });
    await expectBoth(
      root,
      [
        ["/search", "app-slug:search"],
        ["/feed.xml", "rss"],
        ["/og/intro", "og:intro"],
        ["/guide/intro", "kura-doc:guide/intro"],
      ],
      { bundle: true },
    );
  }, 60_000);
});
