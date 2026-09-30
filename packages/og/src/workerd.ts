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
// Own the response the way node.ts and edge.ts do: merge with Headers.set (case-insensitive),
// set content-type last, and let workers-og render the body only. The static import stays —
// a lazy `import()` would drop workers-og from the bundle graph, so wrangler would never
// see the WASM. The render starts when the body is read, not when the response is built,
// so the envelope (status/headers) is synchronous and does not require the workerd runtime.
import type { ReactElement } from "react";
import { ImageResponse as WorkersOgImageResponse } from "workers-og";

export type { ImageResponseOptions } from "./types";
export { loadGoogleFont, loadDefaultFonts, hasCJK, OG_HEADERS } from "./fonts";
export type { OgFont } from "./fonts";

const DEFAULT_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

export class ImageResponse extends Response {
  constructor(element: ReactElement, options: import("./types").ImageResponseOptions = {}) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cancelled) return;
        // Never forward options.headers — workers-og spreads them onto title-case keys.
        const rendered = new WorkersOgImageResponse(element, {
          width: options.width,
          height: options.height,
          fonts: options.fonts,
          emoji: options.emoji,
          debug: options.debug,
        });
        if (cancelled) {
          await rendered.body?.cancel();
          return;
        }
        const bytes = new Uint8Array(await rendered.arrayBuffer());
        if (cancelled) return;
        controller.enqueue(bytes);
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    const headers = new Headers();
    headers.set("cache-control", DEFAULT_CACHE_CONTROL);
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) headers.set(key, value);
    }
    // Contract (types.ts): callers may merge/override any header EXCEPT content-type.
    // Set it last so it always wins, including when the caller used a different casing
    // than the default (the failure mode this wrapper exists to close).
    headers.set("content-type", "image/png");

    super(body, {
      status: options.status ?? 200,
      headers,
    });
  }
}
