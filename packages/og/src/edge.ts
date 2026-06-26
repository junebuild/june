// Vercel / edge-light backend — resolved when the build uses the "edge-light" condition.
// @vercel/og renders OG images with its own resvg WASM (works on Vercel's Edge AND Node runtimes).
//
// @vercel/og is loaded LAZILY via `new Function("return import(m)")` (mirrors node.ts's satori/
// @resvg load) so the bundler never resolves it at build time. Its entry statically imports
// `./yoga.wasm?module`, which rolldown — June's worker bundler — can't bundle; a STATIC
// `export { ImageResponse } from "@vercel/og"` here dragged that WASM into EVERY worker carrying
// the OG route, breaking the build even when OG is prerendered to static files and @vercel/og is
// never called at runtime (externalizing doesn't help: an ESM static import is resolved at module
// load regardless of use). Lazy-loading defers it to first render — edge/Node OG works at runtime
// (the consumer installs @vercel/og), and a static-prerendered route, never invoked, pulls nothing.
import type { ReactElement } from "react";
export type { ImageResponseOptions } from "./types";
export { loadGoogleFont, loadDefaultFonts, hasCJK, OG_HEADERS } from "./fonts";
export type { OgFont } from "./fonts";

type VercelImageResponse = new (element: ReactElement, options?: Record<string, unknown>) => Response;

// TypeScript cannot see through Function() — no static module resolution is attempted.
const _import = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;

export class ImageResponse extends Response {
  constructor(element: ReactElement, options: import("./types").ImageResponseOptions = {}) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    super(readable, {
      status: options.status ?? 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
        ...options.headers,
      },
    });
    const writer = writable.getWriter();
    (_import("@vercel/og") as Promise<{ ImageResponse: VercelImageResponse }>)
      .then(({ ImageResponse: VercelOg }) => {
        // Delegate the actual render to @vercel/og, then pipe its PNG body into ours
        // (so our status/headers above win, matching node.ts's response shape).
        const rendered = new VercelOg(element, {
          width: options.width ?? 1200,
          height: options.height ?? 630,
          fonts: options.fonts,
          emoji: options.emoji,
          debug: options.debug,
        });
        if (!rendered.body) return void writer.close();
        return rendered.body.pipeTo(
          new WritableStream<Uint8Array>({
            write: (chunk) => void writer.write(chunk),
            close: () => void writer.close(),
            abort: (e) => void writer.abort(e),
          }),
        );
      })
      .catch((err: unknown) => void writer.abort(err));
  }
}
