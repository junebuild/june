// Resource route demo: a raw-Response endpoint (here an og:image stand-in).
// route.* exports a handler; it's matched like any route ([slug] from the path),
// returns a Response directly, and is excluded from the sitemap/llms.txt.
import type { RouteContext } from "@junejs/core/route";

export default function og(_request: Request, ctx: RouteContext): Response {
  const slug = String(ctx.params.slug ?? "").replace(/\.png$/, "");
  return new Response(`og:${slug}`, { headers: { "content-type": "image/png" } });
}
