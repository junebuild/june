// Google Fonts subsetting + cache utilities shared across all OG backends.
// Works on Cloudflare Workers (Cache API) and Node.js/dev (in-memory Map).

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  style: "normal" | "italic";
}

const memoryCache = new Map<string, ArrayBuffer>();

/**
 * Load a Google Font subset for the given text. Only the glyphs that appear in
 * `text` are fetched (the `text=` query parameter asks Google to subset the font),
 * so even a full CJK face downloads just a few KB per title.
 *
 * Cache strategy: Cache API (available on Cloudflare Workers and Vercel Edge) first,
 * then in-memory (survives the dev process lifetime).
 */
export async function loadGoogleFont(
  family: string,
  weight: number,
  text: string,
): Promise<ArrayBuffer> {
  const cssUrl =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}` +
    `&text=${encodeURIComponent(text)}`;

  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const cached = await cache?.match(cssUrl);
  if (cached) return cached.arrayBuffer();

  const memo = memoryCache.get(cssUrl);
  if (memo) return memo;

  return _fetchFont(cssUrl, family, cache);
}

async function _fetchFont(cssUrl: string, family: string, cache?: Cache): Promise<ArrayBuffer> {
  // A legacy Safari UA makes Google Fonts respond with TTF; satori requires TTF/OTF (not woff2).
  const css = await fetch(cssUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1",
    },
  }).then((r) => r.text());

  const url = css.match(/src: url\((.+?)\)/)?.[1];
  if (!url) throw new Error(`@junejs/og: could not extract font URL for "${family}"`);

  const buf = await fetch(url).then((r) => r.arrayBuffer());

  await cache?.put(
    cssUrl,
    new Response(buf, { headers: { "cache-control": "public, max-age=604800" } }),
  );
  memoryCache.set(cssUrl, buf);
  return buf;
}

/** True when the string contains CJK characters (Chinese, Japanese, Korean). */
export const hasCJK = (s: string): boolean => /[　-鿿豈-﫿]/.test(s);

/**
 * Convenience: load Inter (always) + Noto Sans TC (when the title contains CJK).
 * Pass `text` as all the strings that will be rendered so the subset is complete.
 */
export async function loadDefaultFonts(text: string): Promise<OgFont[]> {
  const fonts: OgFont[] = [
    {
      name: "Inter",
      data: await loadGoogleFont("Inter", 600, text),
      weight: 600,
      style: "normal",
    },
  ];
  if (hasCJK(text)) {
    fonts.push({
      name: "Noto Sans TC",
      data: await loadGoogleFont("Noto Sans TC", 600, text),
      weight: 600,
      style: "normal",
    });
  }
  return fonts;
}

export const OG_HEADERS = {
  "content-type": "image/png",
  "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
} as const;
