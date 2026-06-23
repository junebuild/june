// Node.js / local dev backend — the "default" condition (no workerd / edge-light).
// Uses satori (JSX → SVG) + @resvg/resvg-js (SVG → PNG, native binding).
// Native bindings are fine for Vercel Node.js functions too; only Edge functions need WASM.
//
// satori and @resvg/resvg-js are DYNAMIC imports (not static) so their type declarations
// are not required at compile time — downstream packages can typecheck without them installed.
import type { ReactElement } from "react";
export { loadGoogleFont, loadDefaultFonts, hasCJK, OG_HEADERS } from "./fonts";
export type { OgFont } from "./fonts";
export type { ImageResponseOptions } from "./types";

type Satori = (element: unknown, opts: unknown) => Promise<string>;
type ResvgClass = new (svg: string) => { render(): { asPng(): Uint8Array } };

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
    Promise.all([
      import("satori") as Promise<{ default: Satori }>,
      import("@resvg/resvg-js") as Promise<{ Resvg: ResvgClass }>,
    ])
      .then(([{ default: satori }, { Resvg }]) =>
        satori(element, {
          width: options.width ?? 1200,
          height: options.height ?? 630,
          fonts: options.fonts ?? [],
        }).then((svg) => {
          const png = new Resvg(svg).render().asPng();
          writer.write(new Uint8Array(png));
          writer.close();
        }),
      )
      .catch((err: unknown) => writer.abort(err));
  }
}
