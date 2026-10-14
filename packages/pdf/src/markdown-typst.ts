// Markdown → Typst source, for a renderer on a Typst compiler (@junejs/pdf-typst-wasm). Pure (no WASM), so it is tested on its own.
//
// Every run of text is emitted as a Typst STRING LITERAL in code mode — `#"text";` — never as
// markup. Typst markup gives meaning to dozens of characters (`#`, `*`, `_`, `$`, `@`, `<`,
// `//`, `=` or `-` at a line start…), and a model's Markdown contains all of them: a price, an
// email address, a URL, a C comment. Escaping them one by one is a list that is always
// incomplete; a string literal needs only `\` and `"` escaped. The trailing `;` ends the
// embedded expression, so a following `.` or `[` can never be read as a field access or a
// content argument. Structure (headings, lists, tables, …) is emitted as Typst function calls
// whose content arguments are built the same way.
//
// Images are not fetched (the compiler has no network): an image renders as its alt text.

import { Lexer, type Token, type Tokens } from "marked";

import { STRONG } from "./bidi-classes";
import type { PdfDocument } from "./renderer";

export type TypstSourceOptions = {
  // Font families in order of preference; Typst falls back to any loaded font that has the
  // glyph, so CJK text still renders when the first family is Latin-only.
  fonts?: string[];
};

export function markdownToTypst(markdown: string): string {
  return body(lex(markdown));
}

const lex = (markdown: string) => new Lexer({ gfm: true }).lex(markdown);
const body = (tokens: Token[], base: Dir = "ltr") => blocks(tokens, "\n\n", base).trim() + "\n";

// The whole document: page and text setup, then the body.
export function typstSource(doc: PdfDocument, opts: TypstSourceOptions = {}): string {
  const lines: string[] = [];
  const meta = [doc.title ? `title: ${str(doc.title)}` : "", doc.author ? `author: ${str(doc.author)}` : ""].filter(Boolean);
  if (meta.length) lines.push(`#set document(${meta.join(", ")})`);
  lines.push(`#set page(paper: ${str(doc.paper === "us-letter" ? "us-letter" : "a4")}, margin: (x: 2.2cm, y: 2.4cm), numbering: "1")`);
  const tokens = lex(doc.markdown);
  const lang = langArgs(doc.lang);
  // The document's direction: Typst takes it from `lang` (its own table, mirrored in
  // RTL_LANGS); without a lang, from the first strong character that renders, as Unicode's bidi
  // rule P2 does for a paragraph (#392). Each block then takes its own the same way and is
  // turned only where it differs, like HTML's dir="auto": an Arabic paragraph in an English
  // report reads right to left, and the other way round.
  const base: Dir = lang.length ? (RTL_LANGS.has(doc.lang!.toLowerCase().split(/[-_]/)[0]!) ? "rtl" : "ltr") : (firstStrong(tokens) ?? "ltr");
  const text = ["size: 10.5pt", ...lang, ...(lang.length === 0 && base === "rtl" ? ["dir: rtl"] : [])];
  if (opts.fonts?.length) text.push(`font: (${opts.fonts.map(str).join(", ")},)`);
  lines.push(`#set text(${text.join(", ")})`);
  lines.push(
    "#set par(justify: true, leading: 0.75em)",
    "#show heading: set block(above: 1.4em, below: 0.9em)",
    '#show link: set text(fill: rgb("#1f4e9e"))',
    "#set table(stroke: 0.5pt + luma(170), inset: 6pt)",
    "#show raw.where(block: true): block.with(fill: luma(245), inset: 8pt, radius: 3pt, width: 100%)",
    "",
  );
  return lines.join("\n") + body(tokens, base);
}

// BCP 47 → Typst's `lang` (ISO 639) and `region` (ISO 3166-1 alpha-2). A tag Typst can't take
// (a script subtag alone, a malformed tag) contributes what it can, or nothing.
function langArgs(tag: string | undefined): string[] {
  if (!tag) return [];
  const [lang, ...rest] = tag.toLowerCase().split(/[-_]/);
  if (!lang || !/^[a-z]{2,3}$/.test(lang)) return [];
  const region = rest.find((p) => /^[a-z]{2}$/.test(p));
  return [`lang: ${str(lang)}`, ...(region ? [`region: ${str(region)}`] : [])];
}

type Dir = "ltr" | "rtl";

// The languages Typst sets right to left (typst-library's Lang::dir), so a block is compared
// with the direction Typst actually gives the document.
const RTL_LANGS = new Set(["ar", "dv", "fa", "he", "ks", "pa", "ps", "sd", "ug", "ur", "yi"]);

// A code point's strong direction by its Unicode Bidi_Class (bidi-classes.ts): L is ltr, R and
// AL are rtl, anything else (digits, punctuation, marks, spaces) is not strong.
function strong(cp: number): Dir | undefined {
  let lo = 0;
  let hi = STRONG.length / 3 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = STRONG[mid * 3]!;
    if (cp < start) hi = mid - 1;
    else if (cp > STRONG[mid * 3 + 1]!) lo = mid + 1;
    else return STRONG[mid * 3 + 2] ? "rtl" : "ltr";
  }
  return undefined;
}

// The direction of the first strong character the tokens put on the page (rule P2); undefined
// when there is none, and the block keeps the direction around it. As P2 says, text between an
// isolate initiator (LRI, RLI, FSI) and its matching PDI is skipped, and an isolate left open
// skips the rest of this block only: each call is one block.
function firstStrong(tokens: Token[]): Dir | undefined {
  let isolated = 0;
  for (const run of rendered(tokens)) {
    for (const ch of run) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x2066 && cp <= 0x2068) isolated++;
      else if (cp === 0x2069) isolated = Math.max(0, isolated - 1);
      else if (!isolated) {
        const dir = strong(cp);
        if (dir) return dir;
      }
    }
  }
  return undefined;
}

// The text runs block() and inline() put on the page, in order, as rendered: HTML through
// htmlText, entities decoded, a link as its text, an image as its alt text, a code block
// verbatim.
function* rendered(tokens: Token[]): Generator<string> {
  for (const t of tokens) {
    const x = t as { type: string; text?: string; tokens?: Token[] };
    switch (t.type) {
      case "code":
        yield (t as Tokens.Code).text;
        break;
      case "html":
        yield decodeEntities(htmlText(x.text ?? ""));
        break;
      case "image":
        yield decodeEntities((t as Tokens.Image).text || "[image]");
        break;
      case "link":
        yield* rendered((t as Tokens.Link).tokens);
        break;
      case "list":
        for (const item of (t as Tokens.List).items) yield* rendered(item.tokens);
        break;
      case "table": {
        const tb = t as Tokens.Table;
        for (const c of tb.header) yield* rendered(c.tokens);
        for (const row of tb.rows) for (const c of row) yield* rendered(c.tokens);
        break;
      }
      case "space":
      case "def":
      case "hr":
      case "checkbox":
        break;
      default:
        if (x.tokens) yield* rendered(x.tokens);
        else if (x.text) yield decodeEntities(x.text);
    }
  }
}

// Content set in `dir`, for a block whose direction differs from the one around it.
function turned(content: string, dir: Dir): string {
  return content ? `#[#set text(dir: ${dir})\n${content}]` : content;
}

// ── blocks ──────────────────────────────────────────────────────────────────

// Blocks are separated by a paragraph break — except inside a tight list item, where a
// break would loosen the list; a single newline is a space in Typst markup, and the
// block-level calls that follow (a nested list) start their own line regardless.
// Each block in its own direction (its first strong character), turned where that differs
// from `dir`, the direction around it — for the blocks `turns` accepts; the rest keep `dir`.
function blocks(tokens: Token[], sep = "\n\n", dir: Dir = "ltr", turns: (t: Token) => boolean = () => true): string {
  return tokens
    .map((t) => {
      const own = turns(t) ? (firstStrong([t]) ?? dir) : dir;
      const out = block(t, own);
      return own === dir ? out : turned(out, own);
    })
    .filter((s) => s !== "")
    .join(sep);
}

function block(t: Token, dir: Dir): string {
  switch (t.type) {
    case "heading": {
      const h = t as Tokens.Heading;
      return `#heading(level: ${Math.min(Math.max(h.depth, 1), 6)})[${inlines(h.tokens)}]`;
    }
    case "paragraph":
      return inlines((t as Tokens.Paragraph).tokens);
    case "text": {
      // Block-level text: the content of a tight list item.
      const x = t as Tokens.Text;
      return x.tokens ? inlines(x.tokens) : text(x.text);
    }
    case "code": {
      const c = t as Tokens.Code;
      const lang = c.lang?.trim().split(/\s+/)[0];
      return `#raw(block: true, ${lang ? `lang: ${str(lang)}, ` : ""}${str(c.text)})`;
    }
    case "blockquote":
      return `#quote(block: true)[${blocks((t as Tokens.Blockquote).tokens, "\n\n", dir)}]`;
    case "list":
      return list(t as Tokens.List, dir);
    case "table":
      return table(t as Tokens.Table, dir);
    case "hr":
      return "#line(length: 100%, stroke: 0.5pt + luma(170))";
    case "html":
      return text(htmlText((t as Tokens.HTML).text).trim());
    case "space":
    case "def":
      return "";
    default: {
      // A token type this converter doesn't know (an extension): keep its text, never drop it.
      const x = t as { tokens?: Token[]; text?: string };
      return x.tokens ? inlines(x.tokens) : x.text ? text(x.text) : "";
    }
  }
}

function list(l: Tokens.List, dir: Dir): string {
  const items = l.items.map((item) => {
    const body = item.tokens.filter((x) => x.type !== "checkbox");
    const box = item.task ? `#${str(item.checked ? "☑ " : "☐ ")};` : "";
    // An item's own text keeps the list's direction (blocks() turned the list as a whole):
    // turning it alone would part it from its marker, and it still reads in its own order
    // within the line. A nested list chooses its own direction, as a whole, like any list.
    return `[${box}${blocks(body, l.loose ? "\n\n" : "\n", dir, (x) => x.type === "list")}]`;
  });
  const args = [`tight: ${!l.loose}`];
  if (l.ordered) {
    const start = typeof l.start === "number" ? l.start : 1;
    if (start !== 1) args.push(`start: ${start}`);
  }
  return `#${l.ordered ? "enum" : "list"}(${args.join(", ")}, ${items.join(", ")})`;
}

function table(t: Tokens.Table, dir: Dir): string {
  const align = t.align.map((a) => a ?? "auto");
  // A cell in its own direction, like a block.
  const cell = (tokens: Token[], content: string) => {
    const own = firstStrong(tokens) ?? dir;
    return `[${own === dir ? content : turned(content, own)}]`;
  };
  const header = t.header.map((c) => cell(c.tokens, `#strong[${inlines(c.tokens)}]`));
  const rows = t.rows.flatMap((row) => t.header.map((_, i) => (row[i] ? cell(row[i]!.tokens, inlines(row[i]!.tokens)) : "[]")));
  return [
    "#table(",
    `  columns: ${t.header.length},`,
    `  align: (${align.join(", ")},),`,
    `  table.header(${header.join(", ")}),`,
    ...(rows.length ? [`  ${rows.join(", ")},`] : []),
    ")",
  ].join("\n");
}

// ── inlines ─────────────────────────────────────────────────────────────────

// Adjacent plain runs (text split around an escape or a dropped tag) merge into one literal.
function inlines(tokens: Token[]): string {
  let out = "";
  let run = "";
  const flush = () => { out += text(run); run = ""; };
  for (const t of tokens) {
    const plain = plainText(t);
    if (plain !== undefined) { run += plain; continue; }
    flush();
    out += inline(t);
  }
  flush();
  return out;
}

// The raw text of a token that renders as plain text, undefined for anything else.
function plainText(t: Token): string | undefined {
  if (t.type === "escape") return (t as Tokens.Escape).text;
  if (t.type === "text" && !(t as Tokens.Text).tokens) return (t as Tokens.Text).text;
  if (t.type === "html" && !isBreak((t as Tokens.Tag).text)) return htmlText((t as Tokens.Tag).text);
  return undefined;
}

function inline(t: Token): string {
  switch (t.type) {
    case "text": {
      const x = t as Tokens.Text;
      return x.tokens ? inlines(x.tokens) : text(x.text);
    }
    case "escape":
      return text((t as Tokens.Escape).text);
    case "strong":
      return `#strong[${inlines((t as Tokens.Strong).tokens)}]`;
    case "em":
      return `#emph[${inlines((t as Tokens.Em).tokens)}]`;
    case "del":
      return `#strike[${inlines((t as Tokens.Del).tokens)}]`;
    case "codespan":
      return `#raw(${str(decodeEntities((t as Tokens.Codespan).text))});`;
    case "br":
      return "#linebreak();";
    case "link": {
      const l = t as Tokens.Link;
      const body = inlines(l.tokens);
      return l.href ? `#link(${str(l.href)})[${body}]` : body;
    }
    case "image": {
      const i = t as Tokens.Image;
      return `#emph[${text(i.text ? `[${i.text}]` : "[image]")}]`;
    }
    case "html":
      return isBreak((t as Tokens.Tag).text) ? "#linebreak();" : text(htmlText((t as Tokens.Tag).text));
    default: {
      const x = t as { tokens?: Token[]; text?: string };
      return x.tokens ? inlines(x.tokens) : x.text ? text(x.text) : "";
    }
  }
}

// A run of text as a string literal. A soft line break is a space between words, but
// nothing between two CJK characters — those scripts don't put spaces between words.
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303f\\uff00-\\uffef";
const CJK_BREAK = new RegExp(`([${CJK}])[ \\t]*\\n[ \\t]*(?=[${CJK}])`, "gu");
function text(s: string): string {
  const flowed = decodeEntities(s).replace(CJK_BREAK, "$1").replace(/[ \t]*\n[ \t]*/g, " ");
  return flowed ? `#${str(flowed)};` : "";
}

// A Typst string literal.
function str(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

// HTML in Markdown: the tags of ordinary HTML elements are dropped (their text stays), and
// anything else that merely looks like a tag stays as written — prose such as `Vec<String>`
// or `<placeholder>` is text, not markup, and must not vanish from the PDF.
const HTML_TAGS = new Set(
  "a abbr b big blockquote br center code del details div em font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong sub summary sup table tbody td th thead tr tt u ul var".split(" "),
);
function htmlText(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, name: string) => (HTML_TAGS.has(name.toLowerCase()) ? "" : tag));
}

function isBreak(html: string): boolean {
  return /^<br\b[^>]*>$/i.test(html.trim()); // <br>, <br/>, <br class="…">
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
