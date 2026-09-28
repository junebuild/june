// withAssets is the deployed worker's outer layer: it makes prerendered pages
// (served from the ASSETS binding, bypassing the pipeline) still carry the
// agent-ready signals — Link header, Accept:markdown negotiation, token count.
import { describe, expect, test } from "bun:test";

import { withAssets } from "../src/worker";

const LINK = '</.well-known/api-catalog>; rel="api-catalog"';

// A fake ASSETS binding backed by a path→[body, contentType] map.
function fakeAssets(files: Record<string, [string, string]>) {
  return {
    fetch: async (req: Request) => {
      // Mimic Cloudflare's asset resolution: `/why` → `/why.html`, `/` → `/index.html`.
      const p = new URL(req.url).pathname;
      const hit = files[p] ?? files[`${p}.html`] ?? files[`${p === "/" ? "" : p}/index.html`];
      return hit
        ? new Response(hit[0], { status: 200, headers: { "content-type": hit[1] } })
        : new Response("not found", { status: 404 });
    },
  };
}

const pipeline = { fetch: async () => new Response("DYNAMIC", { status: 200 }) };
const get = (path: string, headers?: Record<string, string>) =>
  new Request(`https://x${path}`, { headers });

describe("withAssets", () => {
  const env = {
    ASSETS: fakeAssets({
      "/index.html": ["<html><body>home</body></html>", "text/html; charset=utf-8"],
      "/index.md": ["# Home\n", "text/markdown"],
      "/why.html": ["<html><body>why</body></html>", "text/html; charset=utf-8"],
    }),
  };
  const worker = withAssets(pipeline, { link: LINK });

  test("Accept: text/markdown on the homepage serves the prerendered .md asset", async () => {
    const res = await worker.fetch(get("/", { accept: "text/markdown" }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("x-markdown-tokens")).toBeTruthy();
    expect(res.headers.get("link")).toBe(LINK);
    expect(await res.text()).toContain("# Home");
  });

  test("a prerendered HTML page gets the Link header injected", async () => {
    const res = await worker.fetch(get("/why"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("link")).toBe(LINK);
  });

  test("a request with no matching asset falls through to the pipeline", async () => {
    const res = await worker.fetch(get("/api/dynamic"), env);
    expect(await res.text()).toBe("DYNAMIC");
  });

  test("Accept: text/markdown with no prerendered .md falls through to the pipeline", async () => {
    const res = await worker.fetch(get("/api/dynamic", { accept: "text/markdown" }), env);
    expect(await res.text()).toBe("DYNAMIC");
  });

  // One URL, two bodies chosen by Accept — a cache that ignores Accept hands an
  // agent the HTML (or a browser the Markdown).
  test("both variants of a page path carry Vary: Accept", async () => {
    const md = await worker.fetch(get("/", { accept: "text/markdown" }), env);
    expect(md.headers.get("vary")).toBe("accept");
    const html = await worker.fetch(get("/why"), env);
    expect(html.headers.get("vary")).toBe("accept");
  });

  test("Vary: Accept merges with the asset layer's own Vary", async () => {
    const assets = {
      fetch: async () =>
        new Response("<html></html>", { headers: { "content-type": "text/html", vary: "Accept-Encoding" } }),
    };
    const res = await withAssets(pipeline).fetch(get("/why"), { ASSETS: assets });
    expect(res.headers.get("vary")).toBe("Accept-Encoding, accept");
  });

  // /docs/index is its own route (twin: /docs/index.md). With no /docs.md asset
  // (dynamic /docs, or md = false), Accept: text/markdown /docs must reach the
  // pipeline — never be answered with the /docs/index page's markdown.
  test("a nested index route's .md is never served for its parent path", async () => {
    const assets = fakeAssets({ "/docs/index.md": ["# docs/index page\n", "text/markdown"] });
    const res = await withAssets(pipeline).fetch(get("/docs", { accept: "text/markdown" }), { ASSETS: assets });
    expect(await res.text()).toBe("DYNAMIC");
  });

  // A prerendered route with md = false has an HTML asset but no .md. A client
  // that PREFERS markdown must get the pipeline's answer (404 for the disabled
  // projection), not the HTML it ranked lower; one that prefers HTML gets the asset.
  describe("md-disabled prerendered route", () => {
    const assets = fakeAssets({ "/plain.html": ["<html>plain</html>", "text/html; charset=utf-8"] });
    const md404 = {
      fetch: async () => new Response("# 404 — Not found\n", { status: 404, headers: { "content-type": "text/markdown" } }),
    };
    const w = withAssets(md404);

    test("pure markdown Accept → the pipeline's 404, not the HTML asset", async () => {
      const res = await w.fetch(get("/plain", { accept: "text/markdown" }), { ASSETS: assets });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("# 404 — Not found\n");
    });

    test("markdown preferred over HTML → still the pipeline", async () => {
      const res = await w.fetch(get("/plain", { accept: "text/markdown, text/html;q=0.9" }), { ASSETS: assets });
      expect(res.status).toBe(404);
    });

    test("HTML preferred over markdown → the HTML asset", async () => {
      const res = await w.fetch(get("/plain", { accept: "text/html, text/markdown;q=0.5" }), { ASSETS: assets });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>plain</html>");
    });
  });

  // Every negotiated target gets its own representation or the pipeline's
  // answer — never the prerendered HTML document.
  describe("json and fragment targets on a prerendered page", () => {
    const assets = fakeAssets({
      "/why.html": ["<!DOCTYPE html><html><body><div data-june-root>why</div></body></html>", "text/html"],
      "/data.html": ["<html>data</html>", "text/html"],
      "/data.json": ['{"n":1}', "application/json"],
    });
    const echo = { fetch: async (req: Request) => new Response(`PIPELINE ${req.headers.get("accept")}`) };
    const w = withAssets(echo, { link: LINK });

    test("Accept: application/json → the prerendered .json asset (a json() route)", async () => {
      const res = await w.fetch(get("/data", { accept: "application/json" }), { ASSETS: assets });
      expect(await res.text()).toBe('{"n":1}');
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("vary")).toBe("accept");
      expect(res.headers.get("link")).toBe(LINK);
    });

    test("Accept: application/json with no .json asset → the pipeline, not the HTML", async () => {
      const res = await w.fetch(get("/why", { accept: "application/json" }), { ASSETS: assets });
      expect(await res.text()).toBe("PIPELINE application/json");
    });

    // The client router morphs the response body in as [data-june-root]'s INNER
    // html; the HTML asset is a whole document (nested root, head tags in body).
    test("the soft-nav fragment Accept → the pipeline's fragment, not the document asset", async () => {
      const res = await w.fetch(get("/why", { accept: "text/vnd.june.fragment+html" }), { ASSETS: assets });
      expect(await res.text()).toBe("PIPELINE text/vnd.june.fragment+html");
    });

    test("a browser's Accept still gets the HTML asset", async () => {
      const res = await w.fetch(
        get("/why", { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }),
        { ASSETS: assets },
      );
      expect(await res.text()).toContain("data-june-root");
    });

    test("HEAD with a markdown Accept → the pipeline, not the HTML asset", async () => {
      const res = await w.fetch(new Request("https://x/why", { method: "HEAD", headers: { accept: "text/markdown" } }), {
        ASSETS: assets,
      });
      expect(await res.text()).toBe("PIPELINE text/markdown");
    });
  });

  test("HTML preferred over markdown on a page WITH a .md asset → the HTML asset", async () => {
    const res = await worker.fetch(get("/", { accept: "text/html, text/markdown;q=0.5" }), env);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("a file asset (extension) gets no Vary: Accept", async () => {
    const assets = fakeAssets({ "/logo.svg": ["<svg/>", "image/svg+xml"] });
    const res = await withAssets(pipeline).fetch(get("/logo.svg"), { ASSETS: assets });
    expect(res.headers.get("vary")).toBeNull();
  });

  test("no ASSETS binding → transparent pass-through to the pipeline", async () => {
    const res = await withAssets(pipeline, { link: LINK }).fetch(get("/why"), {});
    expect(await res.text()).toBe("DYNAMIC");
  });
});

// On workerd, handing the incoming Request to env.ASSETS.fetch() transfers its body
// stream: a 404 from assets then leaves the pipeline a Request whose body is already
// used, so POST /mcp answered -32700 "Parse error" and actions lost their input — but
// only when deployed (the Bun dev host has no ASSETS). This fake models that: it
// drains any body it's handed, and records every method it was asked to serve.
describe("withAssets: non-GET requests keep their body", () => {
  function drainingAssets() {
    const methods: string[] = [];
    return {
      methods,
      binding: {
        fetch: async (req: Request) => {
          methods.push(req.method);
          if (req.body) await req.text(); // the binding consumes the stream, as on workerd
          return new Response("not found", { status: 404 });
        },
      },
    };
  }
  // The pipeline echoes the body it receives — or reports that it had none left.
  const echo = {
    fetch: async (req: Request) => (req.bodyUsed ? new Response("BODY ALREADY USED", { status: 500 }) : new Response(await req.text())),
  };
  const rpc = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';

  test("POST /mcp reaches the pipeline with its JSON body intact", async () => {
    const assets = drainingAssets();
    const req = new Request("https://x/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: rpc });
    const res = await withAssets(echo, { link: LINK }).fetch(req, { ASSETS: assets.binding });
    expect(await res.text()).toBe(rpc);
    expect(assets.methods).toEqual([]); // assets never see a write — they only serve reads
  });

  for (const method of ["PUT", "PATCH", "DELETE"]) {
    test(`${method} bypasses the assets and keeps its body`, async () => {
      const assets = drainingAssets();
      const req = new Request("https://x/some/action", { method, body: "payload" });
      const res = await withAssets(echo).fetch(req, { ASSETS: assets.binding });
      expect(await res.text()).toBe("payload");
      expect(assets.methods).toEqual([]);
    });
  }

  test("GET and HEAD are still served from the assets first", async () => {
    const assets = drainingAssets();
    const worker = withAssets(echo);
    await worker.fetch(get("/why"), { ASSETS: assets.binding });
    await worker.fetch(new Request("https://x/why", { method: "HEAD" }), { ASSETS: assets.binding });
    expect(assets.methods).toEqual(["GET", "HEAD"]);
  });
});
