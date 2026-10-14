// Font providers (#371): where a PDF's fonts come from decides where the document goes. A
// provider fetching per-document subsets sends the document's characters to a third party;
// one reading bundled bytes sends nothing. That is the app's or the installer's call, so the
// renderer makes no network call unless the app lists a provider that does, and every
// provider declares its `egress` — what leaves the process, and to which host — so an app
// can show the trade-off (a doctor check, its docs) without reading this source.
//
// `egress` is a description, not enforcement: a provider an app writes can omit or misstate
// it. Network policy belongs to the `fetch` a provider is given, or to the host.
//
// Nothing here depends on PDF types, so @junejs/og's Google Fonts loading could move onto
// the same providers later.

export type FontEgress = {
  host: string;
  // "nothing": a fixed request (a font file by URL). "document-characters": the request
  // carries the characters of the document being rendered.
  sends: "nothing" | "document-characters";
};

export interface FontProvider {
  // Shown in errors ("google-font-subsets: HTTP 503").
  readonly name: string;
  // Every host this provider contacts; empty when it never touches the network.
  readonly egress: readonly FontEgress[];
  // Font files registered once, for the renderer's lifetime. A failure fails the render and
  // is retried by the next one.
  persistent?(): Promise<Uint8Array[]>;
  // Font files for one document, given its non-ASCII characters; dropped after it. A failure
  // costs only the characters nothing else covers, and the missing glyphs error names it.
  forDocument?(text: string): Promise<Uint8Array[]>;
}

// A font file: bytes, a URL fetched once, or a loader.
export type FontSource = Uint8Array | ArrayBuffer | string | (() => Promise<Uint8Array | ArrayBuffer>);

// The app's own font files, read once. Offline unless a source is a URL, which is fetched once
// at startup and sends nothing about any document.
// `sources` is copied, so `egress` always names what `persistent` fetches.
export function localFonts(input: FontSource[], opts: { fetch?: typeof fetch } = {}): FontProvider {
  const sources = [...input];
  const fetcher = opts.fetch ?? fetch;
  const hosts = [...new Set(sources.filter((s): s is string => typeof s === "string").map((url) => new URL(url).host))];
  return {
    name: "local-fonts",
    egress: hosts.map((host) => ({ host, sends: "nothing" as const })),
    persistent: () => Promise.all(sources.map((s) => loadFont(s, fetcher))),
  };
}

async function loadFont(source: FontSource, fetcher: typeof fetch): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof source === "function") {
    const data = await source();
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  const res = await fetcher(source);
  if (!res.ok) throw new Error(`font ${source}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export type GoogleFont = { family: string; weights?: number[] };

// Per document, each family cut to the document's non-ASCII characters by Google Fonts, the
// way @junejs/og loads fonts: a subset is a few KB where a whole CJK family is tens of MB.
// The name says the trade-off: the characters go to fonts.googleapis.com in the request, and
// the font file's fonts.gstatic.com URL encodes them too.
export function googleFontSubsets(opts: { families: GoogleFont[]; fetch?: typeof fetch }): FontProvider {
  const fetcher = opts.fetch ?? fetch;
  const wanted = opts.families.flatMap((f) => (f.weights ?? [400]).map((w) => [f.family, w] as const));
  // Per provider: a subset fetched through one provider's `fetch` must not answer another's.
  const cache = new Map<string, Promise<Uint8Array>>();
  return {
    name: "google-font-subsets",
    egress: [
      { host: "fonts.googleapis.com", sends: "document-characters" },
      { host: "fonts.gstatic.com", sends: "document-characters" },
    ],
    async forDocument(text) {
      // All settle before any failure is reported, so a failed weight never leaves another
      // weight's fetch running unobserved.
      const settled = await Promise.allSettled(wanted.map(([family, weight]) => googleSubset(cache, family, weight, text, fetcher)));
      const failed = settled.flatMap((s, i) => (s.status === "rejected" ? [`${wanted[i]![0]} ${wanted[i]![1]}: ${message(s.reason)}`] : []));
      if (failed.length) throw new Error(failed.join("; "));
      return settled.map((s) => (s as PromiseFulfilledResult<Uint8Array>).value);
    },
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Google Fonts answers an old Safari with TTF, which Typst reads (it does not read WOFF2).
// Cached, bounded, least recently used out: a re-render of the same document fetches nothing.
const OLD_SAFARI = "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";
const SUBSET_CACHE_MAX = 32;

function googleSubset(cache: Map<string, Promise<Uint8Array>>, family: string, weight: number, text: string, fetcher: typeof fetch): Promise<Uint8Array> {
  const css = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent(text)}`;
  const hit = cache.get(css);
  if (hit) {
    cache.delete(css);
    cache.set(css, hit); // most recently used last
    return hit;
  }
  const load = (async () => {
    const res = await fetcher(css, { headers: { "user-agent": OLD_SAFARI } });
    if (!res.ok) throw new Error(`Google Fonts CSS: HTTP ${res.status}`);
    const url = (await res.text()).match(/src:\s*url\((.+?)\)/)?.[1];
    if (!url) throw new Error("Google Fonts CSS named no font file");
    const font = await fetcher(url);
    if (!font.ok) throw new Error(`Google Fonts file: HTTP ${font.status}`);
    return new Uint8Array(await font.arrayBuffer());
  })();
  load.catch(() => cache.delete(css)); // never cache a failure
  cache.set(css, load);
  if (cache.size > SUBSET_CACHE_MAX) cache.delete(cache.keys().next().value!);
  return load;
}
