// Pre-route escape hatch: the edge-rendered og:image. /og/<slug>.png returns
// a PNG typeset by satori — via workers-og on workerd (og.tsx), via satori +
// resvg-js on the JS dev host (og-dev.tsx). One card definition (og-card.tsx)
// feeds both, so what you preview in dev is what deploys.
import { POSTS } from "./_content";

export default async function extra(_request: Request, url: URL): Promise<Response | null> {
  const og = url.pathname.match(/^\/og\/([A-Za-z0-9._-]+)\.png$/);
  if (!og) return null;

  const entry = POSTS.find((p) => p.slug === og[1]);
  const opts = entry
    ? { title: String(entry.data.title), date: String(entry.data.date ?? "") }
    : { title: "June — the agent-ready React framework", tag: "june.build" };

  // workers-og's WASM loaders only run on workerd (WebSocketPair is its
  // fingerprint); everywhere else the dev rasterizer renders the same card.
  // The runtime-URL specifier is opaque to the bundler, keeping the node-only
  // dev pipeline (satori + a native .node binding) out of the worker graph.
  const isWorkerd = typeof (globalThis as Record<string, unknown>).WebSocketPair !== "undefined";
  try {
    if (isWorkerd) {
      const { ogResponse } = await import("./og");
      return await ogResponse(opts);
    }
    const devModule = new URL("../og-dev.tsx", import.meta.url).href;
    const { ogResponse } = (await import(devModule)) as typeof import("../og-dev");
    return await ogResponse(opts);
  } catch (err) {
    console.error("[june.build] og render failed:", err);
    return new Response("og:image render failed — see server logs.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
