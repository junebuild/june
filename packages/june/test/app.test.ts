// End-to-end against the examples/basic fixture: one load() feeding view / json
// / agent / md, the agent discovery surface, /mcp, and the content pipeline.
// This is the seed of the Phase 3 golden contract (dev and built worker must
// produce byte-equivalent surfaces).

import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp, type JuneApp } from "../src/app";
import { loadJuneConfig } from "../src/config-loader";

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
    expect(html).toContain("<h1>Hello, June</h1>");
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
    expect(txt).toContain("- [/users](/users)");
    expect(txt).toContain("- tool: createUser");
  });

  test("/sitemap.xml lists static routes and skips the [slug] template", async () => {
    const xml = await (await get("/sitemap.xml")).text();
    expect(xml).toContain("<loc>http://june.test/users</loc>");
    expect(xml).not.toContain("[slug]");
  });

  test("/robots.txt and /.well-known/api-catalog and the mcp server-card", async () => {
    expect(await (await get("/robots.txt")).text()).toContain("Sitemap:");
    expect(((await (await get("/.well-known/api-catalog")).json()) as any).linkset).toBeDefined();
    expect(((await (await get("/.well-known/mcp/server-card.json")).json()) as any).tools).toContain("createUser");
  });
});

describe("/mcp endpoint", () => {
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
