// Node.js / local dev backend — the "default" condition (no workerd / edge-light).
// Uses satori (JSX → SVG) + @resvg/resvg-js (SVG → PNG, native binding).
// Native bindings are fine for Vercel Node.js functions too; only Edge functions need WASM.
//
// Modules are loaded via `new Function("return import(m)")` so TypeScript does not
// attempt to resolve them at compile time — satori and @resvg/resvg-js are optional
// devDependencies of @junejs/og and are never installed by downstream consumers.
import type { ReactElement } from "react";
export { loadGoogleFont, loadDefaultFonts, hasCJK, OG_HEADERS } from "./fonts";
export type { OgFont } from "./fonts";
export type { ImageResponseOptions } from "./types";

type Satori = (element: unknown, opts: unknown) => Promise<string>;
type ResvgClass = new (svg: string) => { render(): { asPng(): Uint8Array } };

// TypeScript cannot see through Function() — no static module resolution is attempted.
const _import = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;

export class ImageResponse extends Response {
  constructor(element: ReactElement, options: import("./types").ImageResponseOptions = {}) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    super(readable, {
      status: options.status ?? 200,
      headers: {
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
        ...options.headers,
        // Contract (types.ts): callers may merge/override any header EXCEPT content-type
        // — set it last so it always wins and the body is always served as a PNG.
        "content-type": "image/png",
      },
    });
    const writer = writable.getWriter();
    Promise.all([
      _import("satori") as Promise<{ default: Satori }>,
      _import("@resvg/resvg-js") as Promise<{ Resvg: ResvgClass }>,
    ])
      .then(([{ default: satori }, { Resvg }]) =>
        satori(element, {
          width: options.width ?? 1200,
          height: options.height ?? 630,
          fonts: options.fonts ?? [],
        }).then((svg: string) => {
          const png = new Resvg(svg).render().asPng();
          writer.write(new Uint8Array(png));
          writer.close();
        }),
      )
      .catch((err: unknown) => writer.abort(err));
  }
}
