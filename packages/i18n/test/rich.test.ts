// t.rich — rendering embedded <tag>s to ReactNode. The result is rendered to
// markup to assert the composed output.

import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseMessage } from "../src/compile";
import { formatRich } from "../src/rich";

const render = (node: ReactNode) => renderToStaticMarkup(createElement("div", null, node));

describe("formatRich", () => {
  test("renders a <tag> via its param function", () => {
    const m = parseMessage("Read <link>the docs</link>!");
    const node = formatRich(m, "en", {
      link: (chunks: ReactNode) => createElement("a", { href: "/docs" }, chunks),
    });
    expect(render(node)).toBe('<div>Read <a href="/docs">the docs</a>!</div>');
  });

  test("interpolates args inside a tag", () => {
    const m = parseMessage("<b>{name}</b> joined");
    const node = formatRich(m, "en", {
      name: "Ada",
      b: (chunks: ReactNode) => createElement("strong", null, chunks),
    });
    expect(render(node)).toBe("<div><strong>Ada</strong> joined</div>");
  });

  test("nested tags", () => {
    const m = parseMessage("<outer>a <inner>b</inner> c</outer>");
    const node = formatRich(m, "en", {
      outer: (c: ReactNode) => createElement("p", null, c),
      inner: (c: ReactNode) => createElement("em", null, c),
    });
    expect(render(node)).toBe("<div><p>a <em>b</em> c</p></div>");
  });

  test("a missing tag fn renders the children inline (no crash)", () => {
    const m = parseMessage("x <b>y</b> z");
    expect(render(formatRich(m, "en", {}))).toBe("<div>x y z</div>");
  });
});
