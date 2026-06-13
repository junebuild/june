// THE GOLDEN CONTRACT (rebuild-plan Phase 3): the same fixture app must produce
// BYTE-EQUIVALENT surfaces from the dev server and the built worker. In the PoC
// the title-template and charset parity bugs only surfaced because dogfood pages
// happened to expose them. Here parity is a TEST: dev (fs-driven) and worker
// (frozen-manifest) both delegate to the one render core (pipeline.ts), and we
// assert their responses match — body, status, and content-type — surface by
// surface. A regression that splits the two paths fails here.

import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp, type JuneApp } from "../src/app";
import { loadJuneConfig } from "../src/config-loader";
import { buildManifest } from "../src/build";
import { createWorker } from "../src/worker";

const ROOT = fileURLToPath(new URL("../../../examples/basic", import.meta.url));
const APP_DIR = `${ROOT}/app`;
const ORIGIN = "https://june.test";

let dev: JuneApp;
let worker: { fetch(r: Request): Promise<Response> };

beforeAll(async () => {
  const config = await loadJuneConfig(ROOT);
  dev = createApp({ appDir: APP_DIR, config });
  await dev.warmup();
  worker = createWorker(await buildManifest(ROOT));
});

const SURFACES = [
  "/",
  "/users",
  "/users.json",
  "/users.md",
  "/posts/hello",
  "/posts/hello.md",
  "/notes",
  "/notes/swift",
  "/notes/swift.json",
  "/llms.txt",
  "/sitemap.xml",
  "/robots.txt",
  "/.well-known/api-catalog",
  "/.well-known/mcp/server-card.json",
  "/__extra/ping",
  "/favicon.svg",
  "/favicon.ico",
  "/does/not/exist",
];

describe("golden contract: dev ≡ built worker", () => {
  for (const path of SURFACES) {
    test(`${path} is byte-equivalent`, async () => {
      const [d, w] = await Promise.all([
        dev.fetch(new Request(ORIGIN + path)),
        worker.fetch(new Request(ORIGIN + path)),
      ]);
      const [db, wb] = await Promise.all([d.text(), w.text()]);
      expect(w.status).toBe(d.status);
      expect(w.headers.get("content-type")).toBe(d.headers.get("content-type"));
      expect(wb).toBe(db); // the byte-for-byte assertion
    });
  }

  test("the home document still carries charset + templated title in BOTH", async () => {
    const [d, w] = await Promise.all([
      dev.fetch(new Request(ORIGIN + "/")),
      worker.fetch(new Request(ORIGIN + "/")),
    ]);
    const [db, wb] = await Promise.all([d.text(), w.text()]);
    for (const body of [db, wb]) {
      expect(body).toContain(`<meta charSet="utf-8"/>`);
      expect(body).toContain("<title>June Basic</title>");
      expect(body).toContain("data-june-nav"); // the root layout wrapped both
    }
  });

  test("a POST to /mcp dispatches identically on both paths", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const make = () =>
      new Request(ORIGIN + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    const [d, w] = await Promise.all([dev.fetch(make()), worker.fetch(make())]);
    expect(await w.text()).toBe(await d.text());
  });

  test("streaming Suspense works in the BUILT worker too (loading.tsx threaded through the manifest)", async () => {
    // /slow opts into streaming via its sibling loading.tsx; the manifest must
    // carry the loading component so the worker streams the fallback like dev.
    const html = await (await worker.fetch(new Request(ORIGIN + "/slow"))).text();
    expect(html).toContain('data-loading="slow"'); // fallback flushed = streamed
    expect(html).toContain("streamed in after the shell");
  });
});
