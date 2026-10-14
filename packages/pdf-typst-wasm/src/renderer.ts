// typstWasmRenderer — a PdfRenderer on this package's engine (src/lib.rs): @junejs/pdf's
// Markdown → Typst source, compiled by a PDF-only Typst build with zero imports, so it runs
// on Cloudflare Workers as well as Node, Bun and Deno.
//
// One engine per process or isolate, created on the first render and kept: an isolate's
// requests share 128 MB on Workers, so a render must not cost a fresh instance. Fonts:
//   • embedded — Typst's defaults (Libertinus Serif, New Computer Modern, DejaVu Sans Mono),
//     always there, so a Latin document needs nothing and the default makes no network call;
//   • `fonts` — the app's providers (fonts.ts), in order of preference. A provider's
//     persistent fonts are registered once; its per-document fonts (a CJK subset cut to one
//     document's characters) are dropped after the document, so they never pile up.
// Each render fetches what it needs first, then clears the previous document's fonts, adds
// its own and compiles with no await in between — concurrent renders can't see each other's
// fonts.
//
// A character none of those fonts covers would come out blank: a wrong document that looks
// right, which an agent would hand to its user as if it were right (#368). So it is a
// PdfRenderError by default, naming the characters and any provider that failed; the model
// reads it and can drop a decorative emoji or tell the user. `onMissingGlyphs: "warn"` is for
// an app that accepts the gaps.

import { PdfRenderError, typstSource, type PdfDocument, type PdfRenderer } from "@junejs/pdf";

import { createEngine, TypstCompileError, type TypstEngine, type WasmSource } from "./engine";
import type { FontEgress, FontProvider } from "./fonts";

export type TypstWasmRendererOptions = {
  // The engine module. Default: the dist/typst.wasm this package ships, loaded the way the
  // host runtime needs (see node.ts / workerd.ts).
  wasm?: WasmSource | (() => Promise<WasmSource>);
  // Where fonts beyond the embedded ones come from (default: none, so no network call):
  // localFonts([...]), googleFontSubsets({ families }), or a provider the app writes.
  fonts?: FontProvider[];
  // Font families in order of preference; Typst falls back to any loaded font with the glyph.
  fontFamilies?: string[];
  // Characters no loaded font covers: "error" (default) throws a PdfRenderError naming them;
  // "warn" logs them and returns the PDF with those characters blank.
  onMissingGlyphs?: "error" | "warn";
};

export interface TypstWasmRenderer extends PdfRenderer {
  // Every host the configured fonts contact, and what each is sent; empty means the renderer
  // works offline. Declared by the providers, not observed (see fonts.ts).
  readonly egress: readonly FontEgress[];
}

// How many missing characters a message names before it counts the rest.
const MISSING_SHOWN = 10;

export function createTypstWasmRenderer(defaultWasm: () => Promise<WasmSource>, opts: TypstWasmRendererOptions = {}): TypstWasmRenderer {
  const providers = opts.fonts ?? [];
  let engine: Promise<TypstEngine> | undefined;

  const ready = (): Promise<TypstEngine> =>
    (engine ??= (async () => {
      const wasm = typeof opts.wasm === "function" ? await opts.wasm() : (opts.wasm ?? (await defaultWasm()));
      const e = await createEngine(wasm);
      const persistent = await Promise.all(providers.map((p) => p.persistent?.() ?? []));
      for (const font of persistent.flat()) e.addFont(font, "persistent");
      return e;
    })().catch((err: unknown) => {
      engine = undefined; // a failed start (an unreachable font URL) is retried by the next render
      throw err;
    }));

  return {
    name: "typst-wasm",
    egress: uniqueEgress(providers),
    async render(doc: PdfDocument): Promise<Uint8Array> {
      const source = typstSource(doc, { fonts: opts.fontFamilies });
      const [e, documentFonts] = await Promise.all([ready(), fontsFor(doc, providers)]);
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

function uniqueEgress(providers: FontProvider[]): FontEgress[] {
  const seen = new Map<string, FontEgress>();
  for (const e of providers.flatMap((p) => p.egress)) {
    const prior = seen.get(e.host);
    // A host sent the document's characters by any provider is sent them, full stop.
    if (!prior || e.sends === "document-characters") seen.set(e.host, { host: e.host, sends: e.sends });
  }
  return [...seen.values()];
}

// The document's characters outside ASCII, the text a per-document font must cover. The
// title rides in the PDF metadata, not the body, so it needs no glyphs.
function documentText(doc: PdfDocument): string {
  return [...new Set(doc.markdown.replace(/[\x00-\x7f]/g, ""))].join("");
}

// The per-document fonts that loaded, and a line for each provider that failed. A failure
// doesn't fail the render by itself: another font may cover the characters, and if none
// does, the missing glyphs error carries the line as the reason.
async function fontsFor(doc: PdfDocument, providers: FontProvider[]): Promise<{ fonts: Uint8Array[]; failed: string[] }> {
  const text = documentText(doc);
  const loaders = providers.filter((p) => p.forDocument);
  if (!text || loaders.length === 0) return { fonts: [], failed: [] };
  const settled = await Promise.allSettled(loaders.map((p) => p.forDocument!(text)));
  return {
    fonts: settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])),
    failed: settled.flatMap((s, i) => (s.status === "rejected" ? [`${loaders[i]!.name} failed (${s.reason instanceof Error ? s.reason.message : String(s.reason)})`] : [])),
  };
}

// Written for the model, which reads it as render_pdf's error, and for the app's logs.
function missingGlyphsMessage(missing: string[], failed: string[]): string {
  const shown = missing.slice(0, MISSING_SHOWN).join(" ");
  const more = missing.length > MISSING_SHOWN ? ` (and ${missing.length - MISSING_SHOWN} more)` : "";
  return (
    `no font available to the PDF renderer covers ${shown}${more}, so they would be missing from the document. ` +
    (failed.length ? `${failed.join("; ")}. ` : "") +
    "Remove them from the Markdown if they are decorative (emoji, symbols); otherwise tell the user the PDF can't include them " +
    "until the app adds a font that covers them to typstWasmRenderer's `fonts` (localFonts or googleFontSubsets)."
  );
}
