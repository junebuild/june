// Pre-route escape hatch: the edge-rendered og:image. EVERY page gets one —
// /og/<slug>.png resolves posts, docs, and the core pages, each typeset live
// by satori: via workers-og on workerd (og.tsx), via satori + resvg-js on the
// JS dev host (og-dev.tsx). One card definition (og-card.tsx) feeds both, so
// what you preview in dev is what deploys.
import { DOCS, POSTS } from "./_content";
import { PAGES } from "./content";
import type { OgOptions } from "./og-card";

function ogOptions(slug: string): OgOptions {
  const post = POSTS.find((p) => p.slug === slug);
  if (post) return { title: String(post.data.title), date: String(post.data.date ?? "") };
  const doc = DOCS.find((d) => d.slug === slug);
  if (doc) return { title: String(doc.data.title), tag: "june.build/docs" };
  const page = PAGES.find((p) => p.slug === slug);
  if (page) return { title: page.title, tag: "june.build" };
  return { title: "June — the agent-ready React framework", tag: "june.build" };
}

export default async function extra(_request: Request, url: URL): Promise<Response | null> {
  const og = url.pathname.match(/^\/og\/([A-Za-z0-9._-]+)\.png$/);
  if (!og) return null;

  const opts = ogOptions(og[1]!);

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
