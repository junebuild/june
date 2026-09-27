// The generated web app manifest: its fields from the document config, and the
// pipeline serving it only beside June's own icons.
import { describe, expect, test } from "bun:test";

import { resolveAgent } from "@junejs/core/config";
import type { DocumentConfig } from "@junejs/core/document";

import { createPipeline } from "../src/pipeline";
import { shortName, webManifest } from "../src/web-manifest";

const base: DocumentConfig = {
  site: { name: "June — build agents into real apps", description: "d" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: false,
};

describe("shortName()", () => {
  test("site.shortName, else the name's leading segment", () => {
    expect(shortName({ name: "June — build agents into real apps" })).toBe("June");
    expect(shortName({ name: "Acme | Docs" })).toBe("Acme");
    expect(shortName({ name: "Acme: the platform" })).toBe("Acme");
    expect(shortName({ name: "Acme - Docs" })).toBe("Acme");
    expect(shortName({ name: "Well-Known Co" })).toBe("Well-Known Co"); // a hyphen inside a word isn't a separator
    expect(shortName({ name: "骨董市集" })).toBe("骨董市集");
    expect(shortName({ name: "x", shortName: "Short" })).toBe("Short");
    expect(shortName({})).toBeUndefined();
  });
});

describe("webManifest()", () => {
  test("name, short name, icons (192/512 + maskable), browser display", () => {
    const m = JSON.parse(webManifest(base));
    expect(m).toMatchObject({
      name: "June — build agents into real apps",
      short_name: "June",
      description: "d",
      start_url: "/",
      display: "browser",
    });
    expect(m.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  test("colours follow resolveThemeColor: one colour → both fields; a light/dark pair → neither", () => {
    expect(JSON.parse(webManifest(base))).toMatchObject({ theme_color: "#fbfbf8", background_color: "#fbfbf8" });
    const pair = JSON.parse(webManifest({ ...base, site: { ...base.site, themeColor: { light: "#fff", dark: "#000" } } }));
    expect(pair.theme_color).toBeUndefined();
    expect(pair.background_color).toBeUndefined();
    const styled = JSON.parse(webManifest({ ...base, styles: "/g.css" }));
    expect(styled.theme_color).toBeUndefined(); // app CSS → background unknown
  });

  test("basePath prefixes start_url, scope, and icons", () => {
    const m = JSON.parse(webManifest({ ...base, basePath: "/docs" }));
    expect(m.start_url).toBe("/docs/");
    expect(m.scope).toBe("/docs/");
    expect(m.icons[0].src).toBe("/docs/icon-192.png");
  });
});

describe("the pipeline serves it only beside June's generated icons", () => {
  const pipe = (icons: DocumentConfig["icons"]) =>
    createPipeline({
      docConfig: { ...base, icons },
      agent: resolveAgent(undefined),
      routeList: () => [],
      resolve: async () => null,
    });

  test("generated → application/manifest+json", async () => {
    const res = await pipe({ manifest: "/manifest.webmanifest", generated: true }).fetch(
      new Request("http://x/manifest.webmanifest"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect((await res.json()).short_name).toBe("June");
  });

  test("the app's own icons/manifest → not generated", async () => {
    const res = await pipe({ primary: "/favicon.svg" }).fetch(new Request("http://x/manifest.webmanifest"));
    expect(res.status).toBe(404);
  });
});
