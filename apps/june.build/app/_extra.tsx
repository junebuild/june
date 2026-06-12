// Pre-route escape hatch: the edge-rendered og:image. /og/<slug>.png returns
// a PNG typeset by satori + resvg (see ./og.tsx) — a binary response route()
// has no projection for yet. The dynamic import keeps the WASM machinery out
// of the page-render path until an og:image is actually requested.
import { POSTS } from "./_content";

export default async function extra(_request: Request, url: URL): Promise<Response | null> {
  const og = url.pathname.match(/^\/og\/([A-Za-z0-9._-]+)\.png$/);
  if (!og) return null;
  // workers-og's WASM loaders are workerd-specific: on the Bun host even a
  // try/catch can't contain them (the throw happens inside the response
  // stream's start() and kills the process). Only attempt on workerd —
  // WebSocketPair is its fingerprint. `wrangler dev` is the local way to see
  // the real PNG.
  if (typeof (globalThis as Record<string, unknown>).WebSocketPair === "undefined") {
    return new Response(
      "og:image renders on workerd (deploy, or `wrangler dev` against dist/) — the dev host cannot initialize workers-og's WASM.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const entry = POSTS.find((p) => p.slug === og[1]);
  const { ogResponse } = await import("./og");
  return ogResponse(
    entry
      ? { title: String(entry.data.title), date: String(entry.data.date ?? "") }
      : { title: "June — the agent-ready React framework", tag: "june.build" },
  );
}
