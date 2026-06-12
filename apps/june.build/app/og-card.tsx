// The og:image CARD — one JSX definition + one font-loading strategy, shared
// by BOTH rasterizers: workers-og on workerd (og.tsx) and satori + resvg-js
// on the JS dev host (og-dev.tsx). The pixels match because the inputs match.
import React from "react";

// Runtime `text=` SUBSETTING: the response contains only the glyphs actually
// in the title — a full CJK face is megabytes, the subset for one headline is
// tens of KB. Cached via the workerd Cache API when present; the dev host
// falls back to an in-memory map.
const memoryCache = new Map<string, ArrayBuffer>();

async function loadGoogleFont(family: string, weight: number, text: string): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent(text)}`;
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const cached = await cache?.match(cssUrl);
  if (cached) return cached.arrayBuffer();
  const memo = memoryCache.get(cssUrl);
  if (memo) return memo;
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
  memoryCache.set(cssUrl, buf);
  return buf;
}

const hasCJK = (s: string) => /[　-鿿豈-﫿]/.test(s);

export type OgOptions = { title: string; date?: string; tag?: string };
export type OgFont = { name: string; data: ArrayBuffer; weight: 600; style: "normal" };

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const OG_HEADERS = {
  "content-type": "image/png",
  "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
};

export async function ogFonts(opts: OgOptions): Promise<OgFont[]> {
  const allText = opts.title + (opts.tag ?? "june.build/blog") + "June" + (opts.date ?? "");
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
  return fonts;
}

export function ogCard(opts: OgOptions): React.ReactElement {
  return (
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
      <div style={{ display: "flex", fontSize: "28px", color: "#888888" }}>
        {opts.tag ?? "june.build/blog"}
      </div>
      <div style={{ display: "flex", fontSize: "62px", lineHeight: 1.3, fontWeight: 600, maxWidth: "1050px" }}>
        {opts.title}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: "30px", fontWeight: 600 }}>June</div>
        <div style={{ display: "flex", fontSize: "26px", color: "#888888" }}>{opts.date ?? ""}</div>
      </div>
    </div>
  );
}
