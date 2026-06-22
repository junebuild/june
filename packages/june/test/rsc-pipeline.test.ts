// RSC build pipeline — minimal end-to-end, proving it runs on STANDARD targets
// (worker-safe, no native runtime). These tests BUILD then RUN the bundles, so
// each graph's react-server / normal-react resolution is real and isolated (the
// bundle carries its own React; the test process keeps its normal one).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { bundleServerGraph, bundleSsrGraph, referencesNodeBuiltins } from "../src/rsc-bundle";

const REPO = join(import.meta.dir, "..", "..", ".."); // rolldown cwd: node_modules resolves here
const FLIGHT_ENTRY = join(import.meta.dir, "..", "src", "rsc-runtime", "flight-render.tsx");
const SSR_ENTRY = join(import.meta.dir, "..", "src", "rsc-runtime", "flight-to-html.tsx");
const FIXTURES = join(import.meta.dir, "fixtures", "rsc");

let workdir: string;
beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "june-rsc-"));
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

// Bundle the server graph for an app fixture, run it, return the Flight payload.
async function renderFlightFor(appFixture: string): Promise<{ flight: string; code: string }> {
  const appAlias = join(FIXTURES, appFixture, "App.tsx");
  const code = await bundleServerGraph(FLIGHT_ENTRY, REPO, appAlias);
  const file = join(workdir, `flight-${appFixture.replace(/\//g, "-")}.mjs`);
  writeFileSync(file, code);
  const mod = (await import(file)) as { renderFlight: () => Promise<string> };
  return { flight: await mod.renderFlight(), code };
}

describe("RSC server graph (Flight render)", () => {
  test("a pure server component renders to a worker-safe Flight payload", async () => {
    const { flight, code } = await renderFlightFor("server-only");
    // Server content is in the Flight model rows.
    expect(flight).toContain("Server only");
    expect(flight).toContain("pure server content");
    // Worker-safe: the react-server EDGE build pulls no node:* (Cloudflare/Vercel
    // edge would reject it). This is the deploy-without-our-runtime invariant.
    expect(referencesNodeBuiltins(code)).toBe(false);
  }, 30_000);

  test("a client island becomes a client reference, its server slot children stream as Flight", async () => {
    const { flight } = await renderFlightFor("with-island");
    // The island is emitted as a client REFERENCE (I row), not server-rendered.
    expect(flight).toContain('I["rsc/Tabs"');
    // …and the server-rendered slot children ARE in the payload (the M3 slot model:
    // <Tabs>{server content}</Tabs> crosses the boundary as the island's children).
    expect(flight).toContain("SERVER overview");
    expect(flight).toContain("SERVER details");
    expect(flight).toContain("data-tab");
  }, 30_000);
});

// Build + run the SSR graph once (no app alias — it consumes Flight, not the app).
async function flightToHtml(flight: string): Promise<{ html: string; code: string }> {
  const code = await bundleSsrGraph(SSR_ENTRY, REPO);
  const file = join(workdir, "ssr.mjs");
  writeFileSync(file, code);
  const mod = (await import(file)) as { flightToHtml: (f: string) => Promise<string> };
  return { html: await mod.flightToHtml(flight), code };
}

describe("RSC SSR graph (Flight → HTML)", () => {
  test("a pure server component's Flight renders to worker-safe HTML", async () => {
    const { flight } = await renderFlightFor("server-only");
    const { html, code } = await flightToHtml(flight);
    expect(html).toContain("<h1>Server only</h1>");
    expect(html).toContain("pure server content");
    // First-load HTML produced with NO native runtime, worker-safe.
    expect(referencesNodeBuiltins(code)).toBe(false);
  }, 30_000);

  test("a client island SSRs into HTML — shell + server slot children (full M3)", async () => {
    const { flight } = await renderFlightFor("with-island");
    // App-specific SSR entry wires the webpack shim so the client ref resolves.
    const code = await bundleSsrGraph(
      join(FIXTURES, "with-island", "ssr-entry.tsx"),
      REPO,
    );
    const file = join(workdir, "ssr-island.mjs");
    writeFileSync(file, code);
    const mod = (await import(file)) as { renderHtml: (f: string) => Promise<string> };
    const html = await mod.renderHtml(flight);
    // The island shell SSR'd…
    expect(html).toContain('data-island="tabs"');
    // …wrapping its SERVER-rendered slot children (the M3 slot, now in HTML).
    expect(html).toContain("SERVER overview");
    expect(html).toContain("SERVER details");
    expect(referencesNodeBuiltins(code)).toBe(false);
  }, 30_000);
});
