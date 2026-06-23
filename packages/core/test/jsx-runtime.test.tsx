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

  test("N1: an island with children throws (no silent hydration mismatch)", () => {
    function Box({ children }: { children?: ReactNode }) {
      return <div>{children}</div>;
    }
    expect(() =>
      renderToStaticMarkup(
        <Box client:load>
          <span>x</span>
        </Box>,
      ),
    ).toThrow(/cannot take children/);
  });
});
