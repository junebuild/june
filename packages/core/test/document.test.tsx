import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Document, documentTitle, type DocumentConfig } from "@junejs/core/document";

const baseConfig: DocumentConfig = {
  site: { name: "Acme", titleTemplate: "%s — Acme", description: "Acme site" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: true,
};

describe("documentTitle()", () => {
  test("applies the title template", () => {
    expect(documentTitle({ title: "Posts" }, baseConfig.site)).toBe("Posts — Acme");
  });

  test("does not template the site name into 'Site — Site' on homepages", () => {
    expect(documentTitle({ title: "Acme" }, baseConfig.site)).toBe("Acme");
  });

  test("falls back to the site name with no metadata", () => {
    expect(documentTitle(undefined, baseConfig.site)).toBe("Acme");
  });
});

describe("Document", () => {
  test("emits <meta charSet> (reminder #2: charset lives in the document)", () => {
    const html = renderToStaticMarkup(
      <Document config={baseConfig}>
        <main>hi</main>
      </Document>,
    );
    expect(html).toContain(`<meta charSet="utf-8"/>`);
    // charset must be early in <head> — before <title> — to land in the first 1024 bytes.
    expect(html.indexOf("charSet")).toBeLessThan(html.indexOf("<title>"));
  });

  test("renders the templated title and description", () => {
    const html = renderToStaticMarkup(
      <Document config={baseConfig} metadata={{ title: "Posts", description: "All posts" }}>
        <main />
      </Document>,
    );
    expect(html).toContain("<title>Posts — Acme</title>");
    expect(html).toContain(`name="description" content="All posts"`);
  });

  test("emits OpenGraph tags when openGraph metadata is present", () => {
    const html = renderToStaticMarkup(
      <Document
        config={baseConfig}
        metadata={{ title: "Posts", openGraph: { image: "/og.png" } }}
      >
        <main />
      </Document>,
    );
    expect(html).toContain(`property="og:title"`);
    expect(html).toContain(`property="og:image" content="/og.png"`);
  });

  test("inlines speculation rules only with inline delivery", () => {
    const withRules: DocumentConfig = {
      ...baseConfig,
      speculationRules: JSON.stringify({ prerender: [] }),
    };
    const inline = renderToStaticMarkup(
      <Document config={withRules}>
        <main />
      </Document>,
    );
    expect(inline).toContain(`type="speculationrules"`);

    const header = renderToStaticMarkup(
      <Document config={{ ...withRules, speculationDelivery: "header" }}>
        <main />
      </Document>,
    );
    expect(header).not.toContain(`type="speculationrules"`);
  });
});
