// Worker-side app services: the pipeline seeds the config-declared `services` bag into
// the request scope, so `currentServices()` resolves in a loader/view/action — the twin
// of what a Durable Object seeds for its tools (agent-durable). Tested at the createPipeline
// seam (shared by dev + worker) AND through createWorker (env-bound provider, per-isolate
// memoized), the same shape i18n-pipeline.test.ts uses.

import { describe, expect, test } from "bun:test";

import { resolveAgent, defineServices } from "@junejs/core/config";
import { route } from "@junejs/core/route";
import { type DocumentConfig } from "@junejs/core/document";
import { currentServices } from "@junejs/db";

import { createPipeline, type RouteResolver } from "../src/pipeline";
import { createWorker } from "../src/worker";

const docConfig: DocumentConfig = {
  site: { name: "T" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: false,
};

// A route whose .json projection echoes the ambient services bag back out — so a fetch
// asserts what a loader/action would see.
const probeRoute = route({ json: () => ({ services: currentServices() ?? null }) });
const resolveProbe: RouteResolver = async () => ({ def: probeRoute, params: {}, chain: [] });

function pipelineWith(services?: () => unknown) {
  const pipeline = createPipeline({
    docConfig,
    agent: resolveAgent(undefined),
    routeList: () => [],
    resolve: resolveProbe,
    services,
  });
  return (urlStr: string) => pipeline.fetch(new Request(urlStr));
}

describe("createPipeline seeds config services into the request scope", () => {
  test("a provider makes currentServices() resolve in a loader/projection", async () => {
    const get = pipelineWith(() => ({ greeting: "hi" }));
    expect(await (await get("http://x/thing.json")).json()).toEqual({ services: { greeting: "hi" } });
  });

  test("no provider → currentServices() is undefined (off by absence)", async () => {
    const get = pipelineWith(); // no services
    expect(await (await get("http://x/thing.json")).json()).toEqual({ services: null });
  });

  test("an async provider is awaited before the scope opens", async () => {
    const get = pipelineWith(async () => ({ greeting: "async-hi" }));
    expect(await (await get("http://x/thing.json")).json()).toEqual({ services: { greeting: "async-hi" } });
  });
});

describe("built worker (manifest.services → createWorker, parity with dev)", () => {
  test("the services provider is built from the worker env and reaches the projection", async () => {
    const worker = createWorker({
      routes: { "/thing": probeRoute },
      document: docConfig,
      agent: resolveAgent(undefined),
      services: (env) => ({ region: (env as { REGION?: string } | undefined)?.REGION ?? "none" }),
    });
    const res = await worker.fetch(new Request("http://x/thing.json"), { REGION: "sfo" });
    expect(await res.json()).toEqual({ services: { region: "sfo" } }); // env flowed into the factory
  });

  test("services are memoized per isolate (built once; a later env is not rebuilt)", async () => {
    let builds = 0;
    const worker = createWorker({
      routes: { "/thing": probeRoute },
      document: docConfig,
      agent: resolveAgent(undefined),
      services: (env) => { builds++; return { region: (env as { REGION?: string } | undefined)?.REGION ?? "none" }; },
    });
    // env is stable within one isolate; the second fetch (different env) still gets the
    // first isolate's bag — built once, like the resources provider.
    expect(await (await worker.fetch(new Request("http://x/thing.json"), { REGION: "sfo" })).json()).toEqual({ services: { region: "sfo" } });
    expect(await (await worker.fetch(new Request("http://x/thing.json"), { REGION: "lax" })).json()).toEqual({ services: { region: "sfo" } });
    expect(builds).toBe(1);
  });

  test("no services declared → currentServices() undefined in the worker too", async () => {
    const worker = createWorker({ routes: { "/thing": probeRoute }, document: docConfig, agent: resolveAgent(undefined) });
    expect(await (await worker.fetch(new Request("http://x/thing.json"), {})).json()).toEqual({ services: null });
  });
});

describe("defineServices", () => {
  test("wraps a factory + module path into a ServicesConfig", () => {
    const make = (env: { X: string }) => ({ x: env.X });
    const cfg = defineServices(make, { module: "./app/services.ts" });
    expect(cfg.module).toBe("./app/services.ts");
    expect(cfg.make({ X: "1" })).toEqual({ x: "1" }); // the same factory, callable with the app's env
  });
});
