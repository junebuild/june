import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  island,
  serializeIslandProps,
  deserializeIslandProps,
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PROPS_ATTR,
} from "@junejs/core/islands";
import { Document, type DocumentConfig } from "@junejs/core/document";

// A representative "use client" island used directly (island v2). On the server
// it renders its initial markup with zero JS, inside the hydration marker.
const Counter = island(function Counter({ initial = 0 }: { initial?: number }) {
  const [n] = useState(initial);
  return <button type="button">count: {n}</button>;
});

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

describe("island()", () => {
  test("SSRs the component inside a marker carrying name + serialized props + intent", () => {
    const html = renderToStaticMarkup(<Counter initial={3} />);
    // The marker element wraps the SSR output (visible + indexable, zero JS).
    expect(html).toContain(`<${ISLAND_TAG} `);
    expect(html).toContain(`${ISLAND_NAME_ATTR}="Counter"`); // name derived from the function
    expect(html).toContain(`${ISLAND_PROPS_ATTR}=`);
    expect(html).toContain(`data-june-strategy="load"`); // default intent
    expect(html).toContain("count: 3"); // the component actually rendered

    // The props attribute deserializes back to what hydration will replay.
    const match = html.match(/data-june-props="([^"]*)"/);
    const raw = match?.[1]!.replaceAll("&quot;", '"').replaceAll("&#x27;", "'");
    expect(deserializeIslandProps(raw)).toEqual({ initial: 3 });
  });

  test("stamps an empty props object when none are given", () => {
    const html = renderToStaticMarkup(<Counter />);
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
