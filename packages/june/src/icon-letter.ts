// The default icon's character — shared by the worker's SVG favicon
// (pipeline.ts) and the build's PNG icons (favicon.ts), so both draw the same
// one. Worker-safe: no node:* imports.

// The name's first grapheme, uppercased. A grapheme — not charAt(0) — so an
// emoji, a flag, or a character outside the BMP stays whole instead of
// becoming half a surrogate pair. "" when the name has none.
export function iconLetter(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  const first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)[Symbol.iterator]().next()
    .value?.segment;
  return (first ?? "").toUpperCase();
}
