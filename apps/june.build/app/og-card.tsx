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
  try {
    return await fetchFont(cssUrl, family);
  } catch {
    return fetchFont(cssUrl, family); // one retry — a font CDN blip shouldn't 503 the card
  }
}

async function fetchFont(cssUrl: string, family: string): Promise<ArrayBuffer> {
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
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

// `kind` labels the card ("docs", "blog"); `path` is the page, shown as its
// markdown projection — what an agent would fetch.
export type OgOptions = { title: string; path?: string; kind?: string; date?: string };
export type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 600; style: "normal" };

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// A page's openGraph image fields: its live card (app/og/[slug]/route.ts) plus
// the card's size, so unfurlers lay it out before the PNG arrives. Root-relative
// on purpose — the document resolves it against the public origin
// (deploy.domain), prerendered pages included.
export function ogImage(slug: string) {
  return { image: `/og/${slug}.png`, imageWidth: OG_WIDTH, imageHeight: OG_HEIGHT };
}
export const OG_HEADERS = {
  "content-type": "image/png",
  "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
};

// The card's colors — the site's dark theme tokens (global.css), which is the
// default look; an unfurl has no color scheme to follow.
const C = {
  bg: "#07080a",
  text: "#f2f3f5",
  secondary: "#8c919b",
  muted: "#646a74",
  line: "#1d2026",
  signal: "#5eead4",
  signalLine: "rgba(94, 234, 212, 0.30)",
  grid: "rgba(255, 255, 255, 0.05)",
};

// "/docs/x" → "/docs/x.md"; "/" → "/index.md" (the pipeline's md projection).
const mdPath = (path: string) => (path === "/" ? "/index.md" : `${path.replace(/\/$/, "")}.md`);

function monoText(opts: OgOptions) {
  return `GET ${mdPath(opts.path ?? "/")} ${opts.kind ?? ""} ${opts.date ?? ""} june.build`;
}

export async function ogFonts(opts: OgOptions): Promise<OgFont[]> {
  const sans = opts.title + "June";
  const fonts: OgFont[] = [
    // Inter, not the site's Geist: satori sets some of Geist's spaces
    // (after "y", "e", "s") visibly too wide; Inter's spacing comes out even.
    { name: "Inter", data: await loadGoogleFont("Inter", 600, sans), weight: 600, style: "normal" },
    { name: "Geist Mono", data: await loadGoogleFont("Geist Mono", 400, monoText(opts)), weight: 400, style: "normal" },
  ];
  if (hasCJK(opts.title)) {
    fonts.push({
      name: "Noto Sans TC",
      data: await loadGoogleFont("Noto Sans TC", 600, opts.title),
      weight: 600,
      style: "normal",
    });
  }
  return fonts;
}

// The dark, terminal-grade card: the nav's wordmark, the page title, and the
// request an agent would make for the page's markdown — the site's pitch.
export function ogCard(opts: OgOptions): React.ReactElement {
  const mono = { fontFamily: "'Geist Mono'", fontWeight: 400 } as const;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: C.bg,
        color: C.text,
        fontFamily: "Inter, 'Noto Sans TC'",
      }}
    >
      {/* the hero's faint grid under a signal glow from the top-right */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundImage: `linear-gradient(${C.grid} 1px, transparent 1px), linear-gradient(90deg, ${C.grid} 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
        }}
      />
      {/* a centered gradient on an offset box, not "at 90% 0%": the two
          rasterizers' satori versions place a positioned radial differently */}
      <div
        style={{
          position: "absolute",
          top: "-420px",
          left: "560px",
          width: "900px",
          height: "900px",
          display: "flex",
          backgroundImage: "radial-gradient(circle, rgba(94, 234, 212, 0.16), rgba(94, 234, 212, 0) 70%)",
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          padding: "64px 72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            {/* .j-wm-mark: a light tile with the signal underscore */}
            <div
              style={{ display: "flex", position: "relative", width: "36px", height: "36px", borderRadius: "10px", background: C.text }}
            >
              <div
                style={{ position: "absolute", left: "10px", bottom: "8px", width: "16px", height: "4px", background: C.signal }}
              />
            </div>
            <div style={{ display: "flex", fontSize: "34px", fontWeight: 600, letterSpacing: "-0.5px" }}>June</div>
          </div>
          {opts.kind ? (
            <div
              style={{
                ...mono,
                display: "flex",
                fontSize: "22px",
                color: C.signal,
                padding: "6px 16px",
                border: `1.5px solid ${C.signalLine}`,
                borderRadius: "999px",
              }}
            >
              {opts.kind}
            </div>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: opts.title.length > 48 ? "58px" : "68px",
            lineHeight: 1.15,
            fontWeight: 600,
            letterSpacing: "-1px",
            maxWidth: "1000px",
          }}
        >
          {opts.title}
        </div>
        <div
          style={{
            ...mono,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "24px",
            paddingTop: "28px",
            borderTop: `1.5px solid ${C.line}`,
          }}
        >
          <div style={{ display: "flex", gap: "14px" }}>
            <span style={{ color: C.signal }}>GET</span>
            <span style={{ color: C.secondary }}>{mdPath(opts.path ?? "/")}</span>
          </div>
          <div style={{ display: "flex", color: C.muted }}>{opts.date || "june.build"}</div>
        </div>
      </div>
    </div>
  );
}
