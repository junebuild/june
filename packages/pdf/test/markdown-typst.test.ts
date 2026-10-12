// Markdown → Typst source. The converter's one rule is that text never reaches Typst as
// markup: every run is a string literal, so characters Typst would interpret (#, $, @, //,
// a leading = or -) arrive as themselves. Compiling the output is typst.test.ts's job.

import { describe, expect, test } from "bun:test";

import { markdownToTypst, typstSource } from "../src/markdown-typst";

const t = (md: string) => markdownToTypst(md).trim();

describe("markdownToTypst — text", () => {
  test("text is a string literal; only backslash and quote are escaped", () => {
    expect(t('Price: $5 #1 @team // not a comment <x> "q" \\path')).toBe(String.raw`#"Price: $5 #1 @team // not a comment <x> \"q\" \\path";`);
  });

  test("a line that starts like Typst markup stays text", () => {
    expect(t("\\= not a heading\n\n\\- not a list")).toBe('#"= not a heading";\n\n#"- not a list";');
    expect(t("\\# not a heading")).toBe('#"# not a heading";');
  });

  test("HTML entities decode; HTML formatting tags drop, tag-like prose stays", () => {
    expect(t("a&amp;b &lt;3 &#x4e2d;")).toBe('#"a&b <3 中";');
    expect(t("<b>bold</b> text<!-- note -->")).toBe('#"bold text";');
    expect(t("returns Vec<String> or <placeholder>")).toBe('#"returns Vec<String> or <placeholder>";');
    expect(t("a<br>b")).toBe('#"a";#linebreak();#"b";');
    expect(t('a<br class="page" />b')).toBe('#"a";#linebreak();#"b";');
    expect(t("a<brx>b")).toBe('#"a<brx>b";'); // not a br element
  });

  test("soft breaks: a space between words, nothing between CJK characters", () => {
    expect(t("one\ntwo")).toBe('#"one two";');
    expect(t("營收\n成長")).toBe('#"營收成長";');
  });
});

describe("markdownToTypst — structure", () => {
  test("headings, emphasis, strike, code spans, links, line breaks", () => {
    expect(t("## Q3 *results*")).toBe('#heading(level: 2)[#"Q3 ";#emph[#"results";]]');
    expect(t("**b** ~~s~~ `x[0]`")).toBe('#strong[#"b";]#" ";#strike[#"s";]#" ";#raw("x[0]");');
    expect(t("[docs](https://june.build/docs?a=1&b=2)")).toBe('#link("https://june.build/docs?a=1&b=2")[#"docs";]');
    expect(t("a  \nb")).toBe('#"a";#linebreak();#"b";');
  });

  test("lists: tight and loose, ordered with a start, tasks, nesting", () => {
    expect(t("- a\n- b")).toBe('#list(tight: true, [#"a";], [#"b";])');
    expect(t("3. c\n4. d")).toBe('#enum(tight: true, start: 3, [#"c";], [#"d";])');
    expect(t("- a\n\n- b")).toBe('#list(tight: false, [#"a";], [#"b";])');
    expect(t("- [x] done\n- [ ] todo")).toBe('#list(tight: true, [#"☑ ";#"done";], [#"☐ ";#"todo";])');
    expect(t("- a\n  - b")).toBe('#list(tight: true, [#"a";\n#list(tight: true, [#"b";])])');
  });

  test("tables keep alignment and emphasize the header row", () => {
    expect(t("| Item | Qty |\n|:--|--:|\n| A | 1 |\n| B |")).toBe(
      [
        "#table(",
        "  columns: 2,",
        "  align: (left, right,),",
        '  table.header([#strong[#"Item";]], [#strong[#"Qty";]]),',
        '  [#"A";], [#"1";], [#"B";], [],',
        ")",
      ].join("\n"),
    );
  });

  test("code blocks keep their text verbatim and their language", () => {
    expect(t('```ts\nconst s = "a\\\\b";\n```')).toBe(String.raw`#raw(block: true, lang: "ts", "const s = \"a\\\\b\";")`);
    expect(t("```\nplain\n```")).toBe('#raw(block: true, "plain")');
  });

  test("blockquotes, rules and images", () => {
    expect(t("> quoted")).toBe('#quote(block: true)[#"quoted";]');
    expect(t("---")).toBe("#line(length: 100%, stroke: 0.5pt + luma(170))");
    expect(t("![chart](c.png)")).toBe('#emph[#"[chart]";]');
  });
});

describe("typstSource", () => {
  test("document metadata, paper, language and font preferences", () => {
    const src = typstSource({ markdown: "# Hi", title: 'Q3 "final"', author: "Ops", lang: "zh-TW", paper: "us-letter" }, { fonts: ["Noto Sans TC"] });
    expect(src).toContain(String.raw`#set document(title: "Q3 \"final\"", author: "Ops")`);
    expect(src).toContain('#set page(paper: "us-letter"');
    expect(src).toContain('#set text(size: 10.5pt, lang: "zh", region: "tw", font: ("Noto Sans TC",))');
    expect(src.endsWith('#heading(level: 1)[#"Hi";]\n')).toBe(true);
  });

  test("defaults: a4, no metadata line, no language for a tag Typst can't take", () => {
    const src = typstSource({ markdown: "x", lang: "Hant" });
    expect(src).not.toContain("#set document");
    expect(src).toContain('#set page(paper: "a4"');
    expect(src).toContain("#set text(size: 10.5pt)");
  });
});
