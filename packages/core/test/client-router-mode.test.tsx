// The three-state clientRouter: false | true|"morph" | "flight". Prove the
// resolver normalizes correctly and the document emits the right activation
// signal + applier attribute — and that morph stays byte-identical to the old
// boolean output (no data-june-router for it).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveClientRouter } from "@junejs/core/config";
import { Document, type DocumentConfig } from "@junejs/core/document";

const baseConfig: DocumentConfig = {
  site: { name: "Acme" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: true,
};

describe("resolveClientRouter()", () => {
  test("off by default", () => {
    expect(resolveClientRouter(undefined)).toBe("off");
    expect(resolveClientRouter(false)).toBe("off");
  });
  test("true and \"morph\" both mean morph", () => {
    expect(resolveClientRouter(true)).toBe("morph");
    expect(resolveClientRouter("morph")).toBe("morph");
  });
  test('only "flight" selects flight — never implied by true', () => {
    expect(resolveClientRouter("flight")).toBe("flight");
  });
});

describe("Document clientRouter injection", () => {
  const render = (mode: DocumentConfig["clientRouter"]) =>
    renderToStaticMarkup(
      <Document config={{ ...baseConfig, clientRouter: mode }}>
        <main>hi</main>
      </Document>,
    );

  test('"off" → no swap region, no router attr', () => {
    const html = render("off");
    expect(html).not.toContain("data-june-root");
    expect(html).not.toContain("data-june-router");
  });

  test('"morph" → swap region, but NO router attr (byte-identical to old true)', () => {
    const html = render("morph");
    expect(html).toContain("data-june-root");
    expect(html).not.toContain("data-june-router");
  });

  test('"flight" → swap region + data-june-router="flight"', () => {
    const html = render("flight");
    expect(html).toContain("data-june-root");
    expect(html).toContain('data-june-router="flight"');
  });
});
