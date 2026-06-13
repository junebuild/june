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

  test("no ASSETS binding → transparent pass-through to the pipeline", async () => {
    const res = await withAssets(pipeline, { link: LINK }).fetch(get("/why"), {});
    expect(await res.text()).toBe("DYNAMIC");
  });
});
