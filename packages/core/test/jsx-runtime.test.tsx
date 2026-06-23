/** @jsxImportSource @junejs/core */
// The transform-free island primitive: with jsxImportSource set, the STANDARD JSX
// compile routes <Counter client:*/> through June's jsx(), which emits the island
// marker — no island() wrapper on the component. This file IS compiled with the
// pragma above, so the markers here are produced by the real toolchain path.
import { describe, expect, test } from "bun:test";
import { useState, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// A PLAIN "use client" component — NO island() wrapper anywhere.
function Counter({ initial = 0 }: { initial?: number }) {
  const [n] = useState(initial);
  return <button type="button">count: {n}</button>;
}

describe("jsx-runtime island markers", () => {
  test("a component with client:* compiles to an island marker around its SSR", () => {
    const html = renderToStaticMarkup(<Counter initial={3} client:visible />);
    expect(html).toContain("<june-island");
    expect(html).toContain('data-june-island="Counter"'); // name from the function
    expect(html).toContain('data-june-strategy="visible"');
    expect(html).toContain('data-june-props="{&quot;initial&quot;:3}"'); // directive stripped
    expect(html).toContain("count: 3"); // SSR'd inside the marker
    expect(html).not.toContain("client:visible"); // directive never reaches the DOM
  });

  test("client:only ships an empty marker (no SSR)", () => {
    const html = renderToStaticMarkup(<Counter initial={9} client:only />);
    expect(html).toContain('data-june-strategy="only"');
    expect(html).not.toContain("count: 9"); // not server-rendered
  });

  test("a component WITHOUT a directive passes through (not an island)", () => {
    const html = renderToStaticMarkup(<Counter initial={1} />);
    expect(html).not.toContain("june-island");
    expect(html).toContain("count: 1"); // rendered inline
  });

  test("host elements pass straight through", () => {
    const html = renderToStaticMarkup(<div className="x">hi</div>);
    expect(html).toBe('<div class="x">hi</div>');
  });

  test("slot: an island WITH children SSRs them inside <june-slot> + flags data-june-slot", () => {
    function Shell({ children }: { children?: ReactNode }) {
      return <div className="shell">{children}</div>;
    }
    const html = renderToStaticMarkup(
      <Shell client:visible>
        <p>server content</p>
      </Shell>,
    );
    expect(html).toContain("data-june-slot"); // marked as a slot island
    expect(html).toContain("<june-slot>");
    expect(html).toContain("<p>server content</p>"); // children SSR'd (zero-JS) inside the slot
    expect(html).toContain('class="shell"'); // shell rendered around it
    expect(html).not.toContain('data-june-props="{&quot;children'); // children never serialized
  });

  test("client:only + children throws (nothing is server-rendered to slot)", () => {
    function Shell({ children }: { children?: ReactNode }) {
      return <div>{children}</div>;
    }
    expect(() =>
      renderToStaticMarkup(
        <Shell client:only>
          <p>x</p>
        </Shell>,
      ),
    ).toThrow(/cannot take children/);
  });

  test("I3: whitespace-only children don't make a component a slot island", () => {
    function Box({ children }: { children?: ReactNode }) {
      return <div className="box">{children}</div>;
    }
    const html = renderToStaticMarkup(<Box client:load>{"   "}</Box>);
    expect(html).not.toContain("data-june-slot");
    expect(html).not.toContain("june-slot");
  });
});
