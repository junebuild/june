// The i18n WIRING in the render pipeline: the locale resolution step runs before
// routing, strips the locale prefix so the router matches the bare path, and sets
// ctx.locale — and it's completely inert when no `i18n` is configured. This is the
// dev/worker-shared seam (createPipeline), so testing it here covers both callers.

import { describe, expect, test } from "bun:test";

import { resolveAgent } from "@junejs/core/config";
import { type I18nConfig } from "@junejs/core/i18n";
import { route } from "@junejs/core/route";
import { type DocumentConfig } from "@junejs/core/document";

import { createPipeline, type RouteResolver } from "../src/pipeline";
import { createWorker } from "../src/worker";

const docConfig: DocumentConfig = {
  site: { name: "T" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: false,
};

const i18n: I18nConfig = {
  defaultLocale: "en",
  locales: {
    en: {},
    de: { path: "/de" },
    fr: { domain: "example.fr" },
  },
};

// A pipeline whose stub resolver records the pathname it was asked to match and
// whose single route echoes ctx.locale back through the .json projection.
function makePipeline(opts: { i18n?: I18nConfig } = {}) {
  let matched: string | undefined;
  const resolve: RouteResolver = async (pathname) => {
    matched = pathname;
    return {
      def: route({ json: (_data, ctx) => ({ locale: ctx.locale ?? null }) }),
      params: {},
      chain: [],
    };
  };
  const pipeline = createPipeline({
    docConfig,
    agent: resolveAgent(undefined),
    i18n: opts.i18n,
    routeList: () => [],
    resolve,
  });
  return {
    matchedPath: () => matched,
    get: (urlStr: string, headers?: Record<string, string>) =>
      pipeline.fetch(new Request(urlStr, { headers })),
  };
}

describe("i18n configured", () => {
  test("a sub-path locale is stripped before routing and set on ctx", async () => {
    const p = makePipeline({ i18n });
    const res = await p.get("http://example.com/de/thing.json");
    expect(await res.json()).toEqual({ locale: "de" });
    expect(p.matchedPath()).toBe("/thing"); // router saw the bare path
  });

  test("a domain locale pins without altering the path", async () => {
    const p = makePipeline({ i18n });
    const res = await p.get("http://example.fr/thing.json");
    expect(await res.json()).toEqual({ locale: "fr" });
    expect(p.matchedPath()).toBe("/thing");
  });

  test("an ambiguous path negotiates via Accept-Language, path untouched", async () => {
    const p = makePipeline({ i18n });
    const res = await p.get("http://example.com/thing.json", { "accept-language": "de" });
    expect(await res.json()).toEqual({ locale: "de" });
    expect(p.matchedPath()).toBe("/thing");
  });

  test("the june-locale cookie wins the ambiguous case", async () => {
    const p = makePipeline({ i18n });
    const res = await p.get("http://example.com/thing.json", { cookie: "june-locale=fr" });
    expect(await res.json()).toEqual({ locale: "fr" });
  });

  test("no signal → defaultLocale", async () => {
    const p = makePipeline({ i18n });
    const res = await p.get("http://example.com/thing.json");
    expect(await res.json()).toEqual({ locale: "en" });
  });

  test("resolveLocale hook decides the ambiguous case (and only then)", async () => {
    const calls: string[] = [];
    const withHook: I18nConfig = {
      ...i18n,
      resolveLocale: ({ url }) => {
        calls.push(url.pathname);
        return "fr";
      },
    };
    const p = makePipeline({ i18n: withHook });
    // ambiguous → hook runs, forces fr
    expect(await (await p.get("http://example.com/thing.json")).json()).toEqual({ locale: "fr" });
    // URL pins de → hook must NOT run
    expect(await (await p.get("http://example.com/de/thing.json")).json()).toEqual({
      locale: "de",
    });
    // hook called once, for the ambiguous request only; it sees the RAW request
    // URL (the projection extension isn't stripped until after locale resolution).
    expect(calls).toEqual(["/thing.json"]);
  });
});

describe("built worker (manifest.i18n → createWorker, parity with dev)", () => {
  test("the frozen locales table resolves in the worker too", async () => {
    const worker = createWorker({
      routes: { "/thing": route({ json: (_d, ctx) => ({ locale: ctx.locale ?? null }) }) },
      document: docConfig,
      agent: resolveAgent(undefined),
      i18n,
    });
    // domain locale + sub-path locale both resolve against the same manifest.
    expect(await (await worker.fetch(new Request("http://example.fr/thing.json"))).json()).toEqual({
      locale: "fr",
    });
    expect(
      await (await worker.fetch(new Request("http://example.com/de/thing.json"))).json(),
    ).toEqual({ locale: "de" });
  });
});

describe("i18n absent (off by absence)", () => {
  test("ctx.locale is undefined and the path is never stripped", async () => {
    const p = makePipeline(); // no i18n
    const res = await p.get("http://example.com/de/thing.json");
    expect(await res.json()).toEqual({ locale: null });
    expect(p.matchedPath()).toBe("/de/thing"); // '/de' is just a path segment
  });
});
