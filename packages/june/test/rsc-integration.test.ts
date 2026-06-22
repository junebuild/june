// Per-route RSC coexistence — buildRsc emits a worker for page.rsc.tsx routes, and
// createRscDispatch routes RSC paths there while everything else stays on the SSR
// pipeline. Builds for real, then drives the dispatcher (real RSC worker + a stub
// SSR fetch) to prove both render models coexist behind one fetch handler.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRsc, findRscRoutes, createRscDispatch } from "../src/rsc-build";
import type { DocumentConfig } from "@junejs/core/document";

const APP_ROOT = join(import.meta.dir, "fixtures", "rsc-app");
const DOC_CONFIG: DocumentConfig = {
  site: { name: "RSC" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: false,
};

let out: string;
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "june-rsc-build-"));
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("per-route RSC", () => {
  test("opt-in: scans page.rsc.tsx routes", () => {
    const routes = findRscRoutes(join(APP_ROOT, "app"));
    expect(routes.map((r) => r.path)).toEqual(["/"]);
    // a non-RSC app has none
    expect(findRscRoutes(join(import.meta.dir, "fixtures", "rsc"))).toEqual([]);
  });

  test("dispatcher: RSC path → Flight Document; other path → SSR pipeline", async () => {
    const result = await buildRsc(APP_ROOT, out, DOC_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.paths).toEqual(["/"]);

    const rscWorker = (await import(join(out, result!.worker))) as {
      default: { fetch: (r: Request) => Promise<Response> };
    };

    // Stub SSR pipeline (the real one is tested elsewhere); the dispatcher must
    // never send a non-RSC path to the RSC worker.
    const ssrFetch = async () =>
      new Response("SSR-PIPELINE", { headers: { "content-type": "text/html" } });

    const dispatch = createRscDispatch(ssrFetch, rscWorker.default.fetch, result!.paths);

    // RSC-owned path → the RSC worker renders a full Document via Flight.
    const rsc = await dispatch(new Request("http://x/"));
    expect(rsc.status).toBe(200);
    const rscHtml = await rsc.text();
    expect(rscHtml).toContain("<!DOCTYPE html>");
    expect(rscHtml).toContain("<title>RSC</title>");
    expect(rscHtml).toContain("RSC app root");
    expect(rscHtml).toContain('data-island="tabs"'); // island SSR'd via Flight
    expect(rscHtml).toContain("SERVER overview"); // its server slot children

    // Any other path → the SSR pipeline, untouched.
    const ssr = await dispatch(new Request("http://x/about"));
    expect(await ssr.text()).toBe("SSR-PIPELINE");
  }, 60_000);
});
