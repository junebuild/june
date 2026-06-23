// Node.js / local dev backend — the "default" condition (no workerd / edge-light).
// Uses satori (JSX → SVG) + @resvg/resvg-js (SVG → PNG, native binding).
// Native bindings are fine for Vercel Node.js functions too; only Edge functions need WASM.
//
// This file must NOT be statically imported from inside app/ — that would pull it into the
// worker bundle graph. A June resource route can import it safely because the dev server
// runs in Node.js and the worker build resolves to workerd.ts / edge.ts via conditions.
import type { ReactElement } from "react";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
export { loadGoogleFont, loadDefaultFonts, hasCJK, OG_HEADERS } from "./fonts";
export type { OgFont } from "./fonts";
export type { ImageResponseOptions } from "./types";

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
    satori(element as never, {
      width: options.width ?? 1200,
      height: options.height ?? 630,
      fonts: (options.fonts ?? []) as never,
    })
      .then((svg) => {
        const png = new Resvg(svg).render().asPng();
        writer.write(new Uint8Array(png));
        writer.close();
      })
      .catch((err) => writer.abort(err));
  }
}
