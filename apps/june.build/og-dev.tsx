// The JS-host og:image rasterizer — the SAME card (og-card.tsx), typeset by
// satori's node build (it owns its yoga init) and rasterized by
// @resvg/resvg-js (a napi native binding Bun loads happily). workers-og's
// workerd-specific WASM loaders can't run here; this pipeline produces the
// same pixels from the same inputs, so dev shows the real social card.
//
// This file lives OUTSIDE app/ and _extra.tsx imports it through a runtime
// URL (new URL(..., import.meta.url)), which keeps satori/resvg-js (node-only,
// native .node binding) out of the Rolldown worker graph entirely.
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

import { ogCard, ogFonts, OG_HEADERS, OG_HEIGHT, OG_WIDTH, type OgOptions } from "./app/og-card";

export async function ogResponse(opts: OgOptions): Promise<Response> {
  const svg = await satori(ogCard(opts), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: await ogFonts(opts),
  });
  const png = new Resvg(svg).render().asPng();
  return new Response(new Uint8Array(png), { headers: OG_HEADERS });
}
