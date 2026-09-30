// Cloudflare Workers backend — resolved when the build uses the "workerd" export condition.
// workers-og wraps satori + a Workers-compatible resvg WASM loader; mark it as buildExternal
// in june.config.ts so wrangler's own WASM rules can handle its .wasm assets:
//   build: { external: ["workers-og"] }
//
// Do not re-export workers-og's ImageResponse. It builds
//   { "Content-Type": "image/png", "Cache-Control": "<immutable, max-age=31536000>", ...options.headers }
// with title-case keys. OG_HEADERS (and node.ts / edge.ts) use lowercase keys, so both
// spellings survive the spread and `new Headers` appends them:
//   content-type: image/png, image/png
//   cache-control: public, immutable, no-transform, max-age=31536000, public, max-age=86400, ...
// Own the response the way node.ts and edge.ts do: the envelope comes from
// ogResponseHeaders(), and workers-og renders the body only. The static import stays —
// a lazy `import()` would drop workers-og from the bundle graph, so wrangler would never
// see the WASM. The render starts when the body is read, not when the response is built,
// so the envelope (status/headers) is synchronous and does not require the workerd runtime.
import type { ReactElement } from "react";
import { ImageResponse as WorkersOgImageResponse } from "workers-og";

import { ogResponseHeaders } from "./headers";

export type { ImageResponseOptions } from "./types";
export { loadGoogleFont, loadDefaultFonts, hasCJK, OG_HEADERS } from "./fonts";
export type { OgFont } from "./fonts";

export class ImageResponse extends Response {
  constructor(element: ReactElement, options: import("./types").ImageResponseOptions = {}) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Never forward options.headers — workers-og spreads them onto title-case keys.
        const rendered = new WorkersOgImageResponse(element, {
          width: options.width,
          height: options.height,
          fonts: options.fonts,
          emoji: options.emoji,
          debug: options.debug,
        });
        const bytes = new Uint8Array(await rendered.arrayBuffer());
        // The reader cancelled while the render ran: the stream is closed, drop the bytes.
        if (cancelled) return;
        controller.enqueue(bytes);
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    super(body, { status: options.status ?? 200, headers: ogResponseHeaders(options) });
  }
}
