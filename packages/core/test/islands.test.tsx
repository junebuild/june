import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Island,
  serializeIslandProps,
  deserializeIslandProps,
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PROPS_ATTR,
} from "@junejs/core/islands";
import { Document, type DocumentConfig } from "@junejs/core/document";

// A representative "use client" island: it holds state, so its only point is to
// hydrate. On the server it renders its initial markup with zero JS.
function Counter({ initial = 0 }: { initial?: number }) {
  const [n] = useState(initial);
  return <button type="button">count: {n}</button>;
}

describe("island prop serialization", () => {
  test("roundtrips JSON-serializable props", () => {
    const props = { initial: 3, label: "hi", nested: { ok: true } };
    expect(deserializeIslandProps(serializeIslandProps(props))).toEqual(props);
  });

  test("treats absent/empty/garbage props as no props", () => {
    expect(serializeIslandProps(undefined)).toBe("{}");
    expect(deserializeIslandProps(null)).toEqual({});
    expect(deserializeIslandProps("")).toEqual({});
    expect(deserializeIslandProps("not json")).toEqual({});
  });
});

describe("Island", () => {
  test("SSRs the component inside a marker carrying name + serialized props", () => {
    const html = renderToStaticMarkup(
      <Island name="Counter" component={Counter} props={{ initial: 3 }} />,
    );
    // The marker element wraps the SSR output (visible + indexable, zero JS).
    expect(html).toContain(`<${ISLAND_TAG} `);
    expect(html).toContain(`${ISLAND_NAME_ATTR}="Counter"`);
    expect(html).toContain(`${ISLAND_PROPS_ATTR}=`);
    expect(html).toContain("count: 3"); // the component actually rendered

    // The props attribute deserializes back to what hydration will replay.
    const match = html.match(/data-june-props="([^"]*)"/);
    const encoded = match?.[1];
    expect(encoded).toBeDefined();
    const raw = encoded!.replaceAll("&quot;", '"').replaceAll("&#x27;", "'");
    expect(deserializeIslandProps(raw)).toEqual({ initial: 3 });
  });

  test("stamps an empty props object when none are given", () => {
    const html = renderToStaticMarkup(<Island name="Counter" component={Counter} />);
    expect(html).toContain(`${ISLAND_PROPS_ATTR}="{}"`);
    expect(html).toContain("count: 0"); // the component's own default
  });
});

const baseConfig: DocumentConfig = {
  site: { name: "Acme" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: false,
};

describe("Document client-script injection", () => {
  test("loads the island runtime as a deferred module when configured", () => {
    const html = renderToStaticMarkup(
      <Document config={{ ...baseConfig, clientScript: "/_june/client.js" }}>
        <main />
      </Document>,
    );
    expect(html).toContain(`<script type="module" src="/_june/client.js">`);
    // It loads at the end of <body>, after the markup it hydrates.
    expect(html.indexOf("/_june/client.js")).toBeGreaterThan(html.indexOf("<main"));
  });

  test("ships zero client JS when no clientScript is set", () => {
    const html = renderToStaticMarkup(
      <Document config={baseConfig}>
        <main />
      </Document>,
    );
    expect(html).not.toContain(`type="module"`);
  });
});
