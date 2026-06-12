// Dynamic og:image — no browser anywhere in the pipeline. satori typesets JSX
// (its own flexbox + font shaping, yoga in WASM), resvg (Rust→WASM) rasterizes
// SVG→PNG. workers-og packages both with workerd-safe WASM loaders (raw
// yoga-wasm-web's init deadlocks on workerd — the reason you rarely see this
// done by hand). Ported from the PoC site (june.dev), with one change: ALL
// fonts load at runtime via Google Fonts `text=` subsetting (the PoC bundled
// Inter as a static TTF, which the dev host can't import as bytes).
import React from "react";
import { ImageResponse } from "workers-og";

// Runtime `text=` SUBSETTING: the response contains only the glyphs actually
// in the title — a full CJK face is megabytes, the subset for one headline is
// tens of KB. This is what makes CJK og:images viable at the edge. Cached via
// the workerd Cache API when present (the css2 URL is the key); the dev host
// has no `caches`, so it just fetches.
async function loadGoogleFont(family: string, weight: number, text: string): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent(text)}`;
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const cached = await cache?.match(cssUrl);
  if (cached) return cached.arrayBuffer();
  // A legacy UA makes Google serve TTF (satori can't read woff2).
  const css = await (
    await fetch(cssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1",
      },
    })
  ).text();
  const url = css.match(/src: url\((.+?)\)/)?.[1];
  if (!url) throw new Error(`no font url for ${family}`);
  const buf = await (await fetch(url)).arrayBuffer();
  await cache?.put(cssUrl, new Response(buf, { headers: { "cache-control": "public, max-age=604800" } }));
  return buf;
}

const hasCJK = (s: string) => /[　-鿿豈-﫿]/.test(s);

type OgFont = { name: string; data: ArrayBuffer; weight: 600; style: "normal" };

export async function ogResponse(opts: { title: string; date?: string; tag?: string }): Promise<Response> {
  const tag = opts.tag ?? "june.build/blog";
  const allText = opts.title + tag + "June" + (opts.date ?? "");
  const fonts: OgFont[] = [
    { name: "Inter", data: await loadGoogleFont("Inter", 600, allText), weight: 600, style: "normal" },
  ];
  if (hasCJK(opts.title)) {
    fonts.push({
      name: "Noto Sans TC",
      data: await loadGoogleFont("Noto Sans TC", 600, allText),
      weight: 600,
      style: "normal",
    });
  }
  const image = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px",
          background: "#fbfbf8",
          color: "#1d1d1f",
          fontFamily: "Inter, 'Noto Sans TC'",
        }}
      >
        <div style={{ display: "flex", fontSize: "28px", color: "#888888" }}>{tag}</div>
        <div style={{ display: "flex", fontSize: "62px", lineHeight: 1.3, fontWeight: 600, maxWidth: "1050px" }}>
          {opts.title}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: "30px", fontWeight: 600 }}>June</div>
          <div style={{ display: "flex", fontSize: "26px", color: "#888888" }}>{opts.date ?? ""}</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts,
      headers: { "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
    },
  );
  // Buffer the stream: ImageResponse renders INSIDE its body stream, so a
  // render error would otherwise escape every try/catch after the 200 is
  // already on the wire (and an uncaught stream error kills the Bun host).
  // An og:image is ~30–50KB — buffering is free, and errors become catchable.
  const png = await image.arrayBuffer();
  return new Response(png, { status: image.status, headers: image.headers });
}
