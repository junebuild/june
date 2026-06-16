// The workerd og:image rasterizer — satori + resvg via workers-og, whose
// workerd-safe WASM loaders are the reason you rarely see this done by hand
// (raw yoga-wasm-web's init deadlocks on workerd). The card itself lives in
// og-card.tsx, shared with the dev rasterizer (og-dev.tsx).
import { ImageResponse } from "workers-og";

import { ogCard, ogFonts, OG_HEADERS, OG_HEIGHT, OG_WIDTH, type OgOptions } from "./og-card";

export async function ogResponse(opts: OgOptions): Promise<Response> {
  const image = new ImageResponse(ogCard(opts), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: await ogFonts(opts),
    headers: OG_HEADERS,
  });
  // Buffer the stream: ImageResponse renders INSIDE its body stream, so a
  // render error would otherwise escape every try/catch after the 200 is
  // already on the wire. An og:image is ~30–50KB — buffering is free, and
  // errors become catchable.
  const png = await image.arrayBuffer();
  return new Response(png, { status: image.status, headers: image.headers });
}
