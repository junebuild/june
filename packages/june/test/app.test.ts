// End-to-end against the examples/basic fixture: one load() feeding view / json
// / agent / md, the agent discovery surface, /mcp, and the content pipeline.
// This is the seed of the Phase 3 golden contract (dev and built worker must
// produce byte-equivalent surfaces).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, type JuneApp } from "../src/app";
import { loadJuneConfig } from "../src/config-loader";
import { buildManifest } from "../src/manifest";
import { createWorker } from "../src/worker";

const APP_DIR = fileURLToPath(new URL("../../../examples/basic/app", import.meta.url));

let app: JuneApp;
const get = (path: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`http://june.test${path}`, { headers }));

beforeAll(async () => {
  const config = await loadJuneConfig(APP_DIR);
  app = createApp({ appDir: APP_DIR, config });
  await app.warmup(); // registers defineAction side effects (createUser)
});

describe("view projection (SSR)", () => {
  test("home renders the document shell with charset + templated title + Link", async () => {
    const res = await get("/");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain(`<meta charSet="utf-8"/>`);
    expect(html).toContain("<title>June Basic</title>"); // title == site name → not templated
    expect(html).toContain("Hello from June");
    expect(res.headers.get("link")).toContain(`rel="llms-txt"`);
  });
});

describe("streaming Suspense (loading.tsx opts a route in)", () => {
  test("the loading.tsx fallback is flushed (proof of shell-first streaming)", async () => {
    const html = await (await get("/slow")).text();
    // The fallback reaches the bytes ONLY when React streams: a buffered
    // allReady render resolves the boundary before emitting, so the fallback
    // never appears. Both fallback and the streamed-in view are present.
    expect(html).toContain('data-loading="slow"');
    expect(html).toContain("streamed in after the shell");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  test("the streaming response body is a live stream, not a buffered string", async () => {
    const res = await get("/slow");
    // A real ReadableStream we can read incrementally (vs a pre-rendered string).
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(await res.text()).toContain("streamed in after the shell");
  });

  test("a route without loading.tsx stays buffered (no fallback machinery)", async () => {
    const html = await (await get("/users")).text();
    expect(html).toContain("Ada");
  });

  test("data-derived metadata gates streaming OFF (the <head> needs the title)", async () => {
    // /slow-meta has loading.tsx but a metadata FUNCTION → must buffer so the
    // title renders. No fallback reaches the bytes; the derived title is present.
    const html = await (await get("/slow-meta")).text();
    expect(html).not.toContain('data-loading="slow-meta"');
    expect(html).toContain("<title>Derived Title · June Basic</title>");
    expect(html).toContain("Derived Title");
  });
});

describe("projections from one load()", () => {
  test("/users.json returns the data", async () => {
    const res = await get("/users.json");
    expect(await res.json()).toEqual({ users: [{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }] });
  });

  test("Accept: application/json negotiates the json projection without an extension", async () => {
    const res = await get("/users", { accept: "application/json" });
    expect((await res.json()) as any).toHaveProperty("users");
  });
});

describe("content pipeline", () => {
  test("/posts/hello renders the markdown body to HTML", async () => {
    const html = await (await get("/posts/hello")).text();
    expect(html).toContain('<h1 id="hello-june">Hello, June</h1>'); // headings carry their GitHub-compatible id
  });

  test("/posts/hello.md serves the AUTHORED source verbatim (frontmatter included)", async () => {
    const res = await get("/posts/hello.md");
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const md = await res.text();
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("title: Hello, June");
    expect(md).toContain("# Hello, June");
  });

  test("dynamic [slug] metadata derives the title from frontmatter", async () => {
    const html = await (await get("/posts/hello")).text();
    expect(html).toContain("<title>Hello, June · June Basic</title>");
  });
});

describe("agent discovery surface", () => {
  test("/llms.txt carries the canonical-names stanza, routes, and the tool", async () => {
    const txt = await (await get("/llms.txt")).text();
    expect(txt).toContain("# June Basic");
    expect(txt).toContain("`@junejs/core`");
    // static routes under "Pages": the static metadata title, linking the .md projection
    expect(txt).toContain("## Pages");
    expect(txt).toContain("- [Users](http://june.test/users.md)");
    expect(txt).toContain("- [June Basic](http://june.test/index.md)"); // "/" → /index.md
    expect(txt).not.toMatch(/\]\([^)]*\[/); // a dynamic template without `llms` is never linked
    expect(txt).toContain("- tool: createUser");
  });

  test("every page linked from /llms.txt actually answers (the .md projections exist)", async () => {
    const txt = await (await get("/llms.txt")).text();
    const urls = [...txt.matchAll(/\]\((http:\/\/june\.test[^)]+)\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(3);
    for (const u of urls) {
      const res = await get(new URL(u).pathname);
      expect(res.status, u).toBe(200);
      expect(res.headers.get("content-type"), u).toContain("text/markdown");
    }
  });

  test("/sitemap.xml lists static routes and skips the [slug] template", async () => {
    const xml = await (await get("/sitemap.xml")).text();
    expect(xml).toContain("<loc>http://june.test/users</loc>");
    expect(xml).not.toContain("[slug]");
    // resource routes (app/og/[slug]/route.ts) are machine endpoints, not pages
    expect(xml).not.toContain("/og");
  });

  test("resource route (route.*) returns a raw Response, with params from the path", async () => {
    const res = await get("/og/hello.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("og:hello"); // [slug] = "hello.png" → handler stripped .png
  });

  test("/robots.txt and /.well-known/api-catalog and the mcp server-card", async () => {
    expect(await (await get("/robots.txt")).text()).toContain("Sitemap:");
    expect(((await (await get("/.well-known/api-catalog")).json()) as any).linkset).toBeDefined();
    expect(((await (await get("/.well-known/mcp/server-card.json")).json()) as any).tools).toContain("createUser");
  });

  test("the server card carries the app's identity from june.config site", async () => {
    const card = (await (await get("/.well-known/mcp/server-card.json")).json()) as any;
    expect(card.name).toBe("test.june/june-basic");
    expect(card.title).toBe("June Basic");
    expect(card.description).toBe("The Phase 2 fixture app — the golden dev/built parity contract.");
    expect(card.remotes).toEqual([
      { type: "streamable-http", url: "http://june.test/mcp", supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] },
    ]);
  });

  test("the server card is served as application/mcp-server-card+json with CORS + caching", async () => {
    const res = await get("/.well-known/mcp/server-card.json");
    expect(res.headers.get("content-type")).toBe("application/mcp-server-card+json");
    // …and the api-catalog advertises the card with that same type
    const catalog = (await (await get("/.well-known/api-catalog")).json()) as any;
    const mcp = catalog.linkset.find((c: any) => c.anchor === "http://june.test/mcp");
    expect(mcp["service-desc"][0]).toEqual({
      href: "http://june.test/.well-known/mcp/server-card.json",
      type: res.headers.get("content-type"),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, If-None-Match");
    expect(res.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    // the If-None-Match revalidation header triggers a preflight — answered, not 404'd
    const pre = await app.fetch(new Request("http://june.test/.well-known/mcp/server-card.json", { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    // HEAD (answered by the discovery gate) carries the same media type + CORS, no body
    const h = await app.fetch(new Request("http://june.test/.well-known/mcp/server-card.json", { method: "HEAD" }));
    expect(h.status).toBe(200);
    expect(h.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(h.headers.get("access-control-allow-origin")).toBe("*");
    expect(h.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
    expect(await h.text()).toBe("");
  });

  test("api-catalog carries the RFC 9727 profile, and a rel=api-catalog Link on GET and HEAD (§2)", async () => {
    const res = await get("/.well-known/api-catalog");
    expect(res.headers.get("content-type")).toBe(
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    );
    const LINK = '</.well-known/api-catalog>; rel="api-catalog"';
    expect(res.headers.get("link")).toBe(LINK);
    const head = await app.fetch(new Request("http://june.test/.well-known/api-catalog", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("link")).toBe(LINK);
    expect(await head.text()).toBe("");
  });

  test("agent skills: the index's digest verifies the served SKILL.md bytes", async () => {
    const res = await get("/.well-known/agent-skills/index.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const index = (await res.json()) as any;
    const entry = index.skills[0];
    const md = await get(new URL(entry.url).pathname);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const bytes = new Uint8Array(await md.arrayBuffer());
    expect(entry.digest).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`);
    expect(new TextDecoder().decode(bytes)).toContain("createUser");
    // only the generated skill's own path answers
    expect((await get("/.well-known/agent-skills/other/SKILL.md")).status).toBe(404);
  });

  test("ARD catalog at both well-known paths, CORS-open, advertised in the page head", async () => {
    for (const p of ["/.well-known/ai-catalog.json", "/.well-known/ard.json"]) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const cat = (await res.json()) as any;
      expect(cat.specVersion).toBe("1.0");
      expect(cat.entries.length).toBeGreaterThan(0);
    }
    const html = await (await get("/")).text();
    expect(html).toContain('<link rel="ai-catalog" href="/.well-known/ai-catalog.json" type="application/json"/>');
  });
});

describe("/mcp endpoint", () => {
  test("initialize introduces the app (serverInfo + instructions), not an anonymous server", async () => {
    const res = await app.fetch(
      new Request("http://june.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    const { result } = (await res.json()) as any;
    expect(result.serverInfo).toEqual({ name: "test.june/june-basic", title: "June Basic", version: "0.0.0" });
    expect(result.instructions).toContain("createUser");
    expect(result.instructions).toContain("http://june.test/llms.txt");
  });

  test("tools/list surfaces the registered action", async () => {
    const res = await app.fetch(
      new Request("http://june.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const json = (await res.json()) as any;
    expect(json.result.tools.map((t: any) => t.name)).toContain("createUser");
  });

  test("tools/call dispatches createUser", async () => {
    const res = await app.fetch(
      new Request("http://june.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "createUser", arguments: { name: "Grace" } },
        }),
      }),
    );
    const json = (await res.json()) as any;
    expect(JSON.parse(json.result.content[0].text)).toEqual({ id: 3, name: "Grace" });
  });
});

describe("client islands (dev)", () => {
  test("a page with an <Island> SSRs the marker and the document loads /_june/client.js", async () => {
    const res = await get("/counter");
    const html = await res.text();
    // The island is server-rendered (visible with zero JS)…
    expect(html).toContain(`<june-island data-june-island="Counter"`);
    expect(html).toContain("count: ");
    // …and the document loads the hydration runtime because app/_client.tsx exists.
    expect(html).toContain(`<script type="module" src="/_june/client.js">`);
  });

  test("dev serves /_june/client.js — the bundled registry + hydration runtime", async () => {
    const res = await get("/_june/client.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const code = await res.text();
    expect(code).toContain("june-island"); // the marker contract made it into the bundle
    // The browser has no `process` — NODE_ENV must be baked at bundle time.
    expect(code).not.toContain("process.env.NODE_ENV");
  });
});

describe("not found", () => {
  test("an unmatched route renders the 404 document with a 404 status", async () => {
    const res = await get("/does/not/exist");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("404 — Not found");
  });
});

// Regression: the build manifest merges .june/routes/ (the framework slot for generated routes,
// e.g. kura's docs/home/search), so the DEV resolver must too — else `kura dev` 404s every
// generated page while the built worker serves them. See createApp's juneRoutesDir fallback.
// Fixtures live UNDER the package so their JSX resolves June's configured jsx runtime.
describe("generated routes in .june/routes/ (dev/build parity)", () => {
  const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
  const tmps: string[] = [];
  const fixture = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(PKG_DIR, ".tmp-gen-"));
    tmps.push(root);
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    }
    return root;
  };
  afterAll(() => tmps.forEach((t) => rmSync(t, { recursive: true, force: true })));

  test("a page present ONLY in .june/routes/ is served, not 404'd", async () => {
    const root = fixture({
      "app/page.tsx": "export default function Home(){return <main>app home</main>;}\n",
      ".june/routes/gen/page.tsx": "export default function Gen(){return <main>generated route body</main>;}\n",
    });
    const res = await createApp({ appDir: join(root, "app") }).fetch(new Request("http://june.test/gen"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("generated route body");
  });

  test("/sitemap.xml lists a dynamic route's llms pages with lastmod; staticPaths never run at runtime", async () => {
    const root = fixture({
      "app/page.tsx": "export default function Home(){return <main>home</main>;}\n",
      // llms = false drops a page from llms.txt, not from the sitemap
      "app/about/page.tsx":
        "export default function A(){return <main>about</main>;}\nexport const llms = false;\n",
      // a static route is its own URL only: an entry naming another path is an
      // llms.txt pointer, not a page it serves; its own entry's date still counts
      "app/changelog/page.tsx":
        "export default function C(){return <main>log</main>;}\n" +
        "export const llms = [{ lastModified: '2026-09-01' }, { path: '/elsewhere' }];\n",
      "app/docs/[slug]/page.tsx":
        "export default function D(){return <main>doc</main>;}\n" +
        "export const llms = () => [{ path: '/docs/intro', lastModified: new Date('2026-06-12') }, { path: '/docs/setup' }];\n" +
        // staticPaths are build-only (route contract): a live crawler must not trigger them
        "export const staticPaths = () => { throw new Error('staticPaths ran at runtime'); };\n",
      "app/tags/[tag]/page.tsx": "export default function T(){return <main>tag</main>;}\n", // enumerates nothing
    });
    const res = await createApp({ appDir: join(root, "app") }).fetch(new Request("http://june.test/sitemap.xml"));
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<url><loc>http://june.test/</loc></url>");
    expect(xml).toContain("<url><loc>http://june.test/about</loc></url>");
    expect(xml).toContain("<url><loc>http://june.test/docs/intro</loc><lastmod>2026-06-12</lastmod></url>");
    expect(xml).toContain("<url><loc>http://june.test/docs/setup</loc></url>");
    expect(xml).not.toContain("[");
    expect(xml).not.toContain("/tags");
    expect(xml).toContain("<url><loc>http://june.test/changelog</loc><lastmod>2026-09-01</lastmod></url>");
    expect(xml).not.toContain("/elsewhere");
  });

  test("the built worker runs staticPaths for the sitemap only when created for the static() build", async () => {
    const root = fixture({
      "app/page.tsx": "export default function Home(){return <main>home</main>;}\n",
      "app/docs/[slug]/page.tsx":
        "export default function D(){return <main>doc</main>;}\n" +
        "export const llms = () => [{ path: '/docs/intro' }];\n" +
        "export const staticPaths = ['/docs/intro', '/docs/extra'];\n",
    });
    const manifest = await buildManifest(root);
    const sitemap = async (w: ReturnType<typeof createWorker>) =>
      (await w.fetch(new Request("http://june.test/sitemap.xml"))).text();
    const deployed = await sitemap(createWorker(manifest));
    expect(deployed).toContain("<loc>http://june.test/docs/intro</loc>");
    expect(deployed).not.toContain("/docs/extra");
    const prerender = await sitemap(createWorker(manifest, { staticBuild: true }));
    expect(prerender).toContain("<loc>http://june.test/docs/extra</loc>");
    expect(prerender.match(/docs\/intro</g)).toHaveLength(1); // deduped across llms + staticPaths
  });

  // (the static-build + i18n staticPaths skip is covered in llms-links.test.ts)
  test("with i18n, canonical llms pages get locale alternates; prefixed staticPaths never become <loc>s", async () => {
    const root = fixture({
      "app/page.tsx": "export default function Home(){return <main>home</main>;}\n",
      "app/docs/[slug]/page.tsx":
        "export default function D(){return <main>doc</main>;}\n" +
        "export const llms = () => [{ path: '/docs/intro' }];\n" +
        // the static() producer hands over every locale × slug, already prefixed
        "export const staticPaths = ['/docs/intro', '/de/docs/intro', '/docs/only-static'];\n",
    });
    const i18n = { defaultLocale: "en", locales: { en: {}, de: { path: "/de" } } };
    const app = createApp({ appDir: join(root, "app"), config: { i18n } });
    const xml = await (await app.fetch(new Request("http://june.test/sitemap.xml"))).text();
    expect(xml).toContain("<loc>http://june.test/docs/intro</loc>");
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="de" href="http://june.test/de/docs/intro"/>');
    // staticPaths never become <loc>s under i18n: neither a prefixed copy nor a static-only page
    expect(xml).not.toContain("<loc>http://june.test/de/docs/intro</loc>");
    expect(xml).not.toContain("only-static");
  });

  test("app/ wins on a path collision with .june/routes/", async () => {
    const root = fixture({
      "app/dup/page.tsx": "export default function A(){return <main>from app</main>;}\n",
      ".june/routes/dup/page.tsx": "export default function B(){return <main>from june routes</main>;}\n",
    });
    const res = await createApp({ appDir: join(root, "app") }).fetch(new Request("http://june.test/dup"));
    expect(await res.text()).toContain("from app");
  });
});
