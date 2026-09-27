// Heading slugs — GitHub's, so an author who knows `#section` links on GitHub gets the
// same ids here, and every consumer (the content pipeline's rendered ids, a search
// indexer walking the markdown source, a hand-written in-page link) agrees on ONE
// algorithm. This module is the single source: @junejs/server's content pipeline
// uses it for entry.html ids and entry.headings; downstream code that needs the same
// ids (e.g. deep links from a search index) imports it rather than re-implementing.
//
// Behaves like github-slugger (the algorithm GitHub uses for rendered markdown):
//   • lowercase;
//   • drop every character that is not a letter, combining mark, number, connector
//     punctuation (`_`), hyphen, or space — so punctuation, symbols, and emoji go;
//     letters of every script stay (CJK, Hangul, Cyrillic, accented Latin …);
//   • each space becomes "-" (not collapsed, not trimmed: "A & B" → "a--b", as GitHub).
// One deliberate difference: a heading that slugs to "" gets "section", because
// id="" is not a valid HTML id (github-slugger would emit "" and then "-1" …).

const DROP = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

/** The slug of one heading's text (no de-duplication — see createSlugger). */
export function slugify(text: string): string {
  return text.toLowerCase().replace(DROP, "").replace(/ /g, "-") || "section";
}

/**
 * A stateful slugger for ONE document: call it once per heading, in document order.
 * Repeats are de-duplicated github-slugger style — the first use keeps the bare slug,
 * later ones get -1, -2, … — and a suffixed candidate is re-checked against every id
 * already emitted, so "Setup", "Setup", "Setup 1" → setup, setup-1, setup-1-1.
 */
export function createSlugger(): (text: string) => string {
  const occurrences = new Map<string, number>();
  return (text: string) => {
    const base = slugify(text);
    let id = base;
    while (occurrences.has(id)) {
      const n = occurrences.get(base)! + 1;
      occurrences.set(base, n);
      id = `${base}-${n}`;
    }
    occurrences.set(id, 0);
    return id;
  };
}
