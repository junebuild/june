// End-to-end against the examples/i18n fixture: the whole i18n stack on one app —
// URL→locale resolution, ctx.locale, per-locale content with fallback, dynamic
// <html lang>, hreflang alternates, and the localized sitemap. Proves the pieces
// compose (each is unit-tested separately; this is the integration contract).

import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp, type JuneApp } from "../src/app";
import { loadJuneConfig } from "../src/config-loader";

const APP_DIR = fileURLToPath(new URL("../../../examples/i18n/app", import.meta.url));

let app: JuneApp;
const get = (path: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`http://june.test${path}`, { headers }));

beforeAll(async () => {
  const config = await loadJuneConfig(APP_DIR);
  app = createApp({ appDir: APP_DIR, config });
  await app.warmup();
});

describe("locale routing + per-locale content", () => {
  test("the default locale serves the flat content at the unprefixed URL", async () => {
    const html = await (await get("/docs/intro")).text();
    expect(html).toContain('<html lang="en">'); // ctx.locale = en
    expect(html).toContain("<h1>Introduction</h1>"); // the flat default file
    expect(html).not.toContain("Einführung");
  });

  test("a sub-path locale strips the prefix and serves its variant", async () => {
    const html = await (await get("/de/docs/intro")).text();
    expect(html).toContain('<html lang="de">'); // ctx.locale = de (prefix stripped)
    expect(html).toContain("<h1>Einführung</h1>"); // the German variant, not the default
    expect(html).not.toContain("<h1>Introduction</h1>");
  });

  test("the .md projection is the resolved locale's authored source", async () => {
    const md = await (await get("/de/docs/intro.md")).text();
    expect(md).toContain("title: Einführung");
    expect(md.startsWith("---")).toBe(true);
  });

  test("an untranslated locale falls back to the default file", async () => {
    // fr has no docs/fr/ variant → served the default (English) intro.
    const html = await (await get("/docs/intro", { "accept-language": "fr" })).text();
    expect(html).toContain("<h1>Introduction</h1>");
  });
});

describe("document head", () => {
  test("the resolved locale drives <html lang>", async () => {
    expect(await (await get("/")).text()).toContain('<html lang="en">');
    expect(await (await get("/de")).text()).toContain('<html lang="de">'); // /de → home, German
  });

  test("hreflang alternates list every locale + x-default", async () => {
    const html = await (await get("/docs/intro")).text();
    expect(html).toContain('rel="alternate" hrefLang="de" href="/de/docs/intro"');
    expect(html).toContain('rel="alternate" hrefLang="fr" href="http://june-fr.example/docs/intro"');
    expect(html).toContain('hrefLang="x-default"');
  });
});

describe("sitemap", () => {
  test("each url carries xhtml:link hreflang alternates", async () => {
    const xml = await (await get("/sitemap.xml")).text();
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain('hreflang="de"');
    expect(xml).toContain('href="http://june-fr.example/"'); // fr home, absolute on its domain
  });
});
