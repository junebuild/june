// typstWasmRenderer — a PdfRenderer on this package's engine (src/lib.rs): the same Markdown →
// Typst source as @junejs/pdf's typstRenderer, compiled by a PDF-only Typst build with zero
// imports, so it runs on Cloudflare Workers as well as Node, Bun and Deno.
//
// One engine per process or isolate, created on the first render and kept: an isolate's
// requests share 128 MB on Workers, so a render must not cost a fresh instance. Fonts:
//   • embedded — Typst's defaults (Libertinus Serif, New Computer Modern, DejaVu Sans Mono);
//   • `fonts` — the app's own, registered once for the engine's lifetime;
//   • Google Fonts subsets — per document, the families in `googleFonts` (Noto Sans TC by
//     default) cut to the document's own non-ASCII characters, the way @junejs/og loads
//     fonts. A subset is a few KB where a whole CJK family is tens of MB, and it is dropped
//     after the document, so subsets never pile up in the engine.
// Each render fetches what it needs first, then clears the previous document's fonts, adds
// its own and compiles with no await in between — concurrent renders can't see each other's
// fonts.
//
// A character none of those fonts covers would come out blank: a wrong document that looks
// right, which an agent would hand to its user as if it were right (#368). So it is a
// PdfRenderError by default, naming the characters and any font that failed to load; the
// model reads it and can drop a decorative emoji or tell the user. `onMissingGlyphs: "warn"`
// is for an app that accepts the gaps.

import { PdfRenderError, typstSource, type PdfDocument, type PdfRenderer } from "@junejs/pdf";

import { createEngine, TypstCompileError, type TypstEngine, type WasmSource } from "./engine";

export type FontSource = Uint8Array | ArrayBuffer | string | (() => Promise<Uint8Array | ArrayBuffer>);

export type GoogleFont = { family: string; weights?: number[] };

export type TypstWasmRendererOptions = {
  // The engine module. Default: the dist/typst.wasm this package ships, loaded the way the
  // host runtime needs (see node.ts / workerd.ts).
  wasm?: WasmSource | (() => Promise<WasmSource>);
  // Fonts registered once, for every document: bytes, a URL, or a loader.
  fonts?: FontSource[];
  // Font families in order of preference; Typst falls back to any loaded font with the glyph.
  fontFamilies?: string[];
  // Families fetched per document from Google Fonts, cut to the document's non-ASCII
  // characters (default: Noto Sans TC, regular and bold). false: no network call — supply
  // CJK fonts through `fonts`.
  googleFonts?: GoogleFont[] | false;
  // How fonts are fetched (default: global fetch).
  fetch?: typeof fetch;
  // Characters no loaded font covers: "error" (default) throws a PdfRenderError naming them;
  // "warn" logs them and returns the PDF with those characters blank.
  onMissingGlyphs?: "error" | "warn";
};

// How many missing characters a message names before it counts the rest.
const MISSING_SHOWN = 10;

export const DEFAULT_GOOGLE_FONTS: GoogleFont[] = [{ family: "Noto Sans TC", weights: [400, 700] }];

export function createTypstWasmRenderer(defaultWasm: () => Promise<WasmSource>, opts: TypstWasmRendererOptions = {}): PdfRenderer {
  const fetcher = opts.fetch ?? fetch;
  const google = opts.googleFonts === false ? [] : (opts.googleFonts ?? DEFAULT_GOOGLE_FONTS);
  let engine: Promise<TypstEngine> | undefined;
  // Per renderer, not per module: a subset fetched through one renderer's `fetch` must not
  // answer another renderer that was given a different one.
  const subsets = subsetCache(fetcher);

  const ready = (): Promise<TypstEngine> =>
    (engine ??= (async () => {
      const wasm = typeof opts.wasm === "function" ? await opts.wasm() : (opts.wasm ?? (await defaultWasm()));
      const e = await createEngine(wasm);
      for (const font of await Promise.all((opts.fonts ?? []).map((f) => loadFont(f, fetcher)))) e.addFont(font, "persistent");
      return e;
    })().catch((err: unknown) => {
      engine = undefined; // a failed start (an unreachable font URL) is retried by the next render
      throw err;
    }));

  return {
    name: "typst-wasm",
    async render(doc: PdfDocument): Promise<Uint8Array> {
      const source = typstSource(doc, { fonts: opts.fontFamilies });
      const [e, documentFonts] = await Promise.all([ready(), subsetsFor(doc, google, subsets)]);
      // From here on, synchronous: no other render can interleave.
      e.clearDocumentFonts();
      for (const font of documentFonts.fonts) e.addFont(font, "document");
      let out;
      try {
        out = e.compile(source);
      } catch (err) {
        if (err instanceof TypstCompileError) throw new PdfRenderError(`the document could not be typeset: ${err.message}`, { cause: err });
        throw err;
      } finally {
        e.clearDocumentFonts();
      }
      if (out.missingGlyphs.length === 0) return out.pdf;
      const message = missingGlyphsMessage(out.missingGlyphs, documentFonts.failed);
      if (opts.onMissingGlyphs === "warn") {
        console.warn(`[june] pdf-typst-wasm: ${message}`);
        return out.pdf;
      }
      throw new PdfRenderError(message);
    },
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

// The document's characters outside ASCII, the text a subset must cover. The title rides in
// the PDF metadata, not the body, so it needs no glyphs.
function documentText(doc: PdfDocument): string {
  return [...new Set(doc.markdown.replace(/[\x00-\x7f]/g, ""))].join("");
}

type SubsetLoader = (family: string, weight: number, text: string) => Promise<Uint8Array>;

// The subsets that loaded, and a line for each that didn't. A failed fetch doesn't fail the
// render by itself: another font may cover the characters, and if none does, the missing
// glyphs check reports it with this line as the reason.
async function subsetsFor(doc: PdfDocument, families: GoogleFont[], load: SubsetLoader): Promise<{ fonts: Uint8Array[]; failed: string[] }> {
  const text = documentText(doc);
  if (!text || families.length === 0) return { fonts: [], failed: [] };
  const wanted = families.flatMap((f) => (f.weights ?? [400]).map((w) => [f.family, w] as const));
  const failed: string[] = [];
  const fonts = await Promise.all(
    wanted.map(([family, weight]) =>
      load(family, weight, text).catch((err: unknown) => {
        failed.push(`${family} ${weight} could not be fetched from Google Fonts (${err instanceof Error ? err.message : String(err)})`);
        return undefined;
      }),
    ),
  );
  return { fonts: fonts.filter((f): f is Uint8Array => f !== undefined), failed };
}

// Written for the model, which reads it as render_pdf's error, and for the app's logs.
function missingGlyphsMessage(missing: string[], failed: string[]): string {
  const shown = missing.slice(0, MISSING_SHOWN).join(" ");
  const more = missing.length > MISSING_SHOWN ? ` (and ${missing.length - MISSING_SHOWN} more)` : "";
  return (
    `no font available to the PDF renderer covers ${shown}${more}, so they would be missing from the document. ` +
    (failed.length ? `${failed.join("; ")}. ` : "") +
    "Remove them from the Markdown if they are decorative (emoji, symbols); otherwise tell the user the PDF can't include them " +
    "until the app adds a font that covers them (typstWasmRenderer's `fonts` or `googleFonts`)."
  );
}

// Google Fonts subsets a family to `text` and answers an old Safari with TTF, which Typst
// reads (it does not read WOFF2). Cached, bounded, least recently used out: a re-render of
// the same document fetches nothing.
const OLD_SAFARI = "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";
const SUBSET_CACHE_MAX = 32;

function subsetCache(fetcher: typeof fetch): SubsetLoader {
  const cache = new Map<string, Promise<Uint8Array>>();
  return (family, weight, text) => googleSubset(cache, family, weight, text, fetcher);
}

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
