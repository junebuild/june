// RSC build pipeline — minimal end-to-end, proving it runs on STANDARD targets
// (worker-safe, no native runtime). These tests BUILD then RUN the bundles, so
// each graph's react-server / normal-react resolution is real and isolated (the
// bundle carries its own React; the test process keeps its normal one).
//
// The client-reference wiring is AUTO-GENERATED from "use client" modules
// (rscClientReferencesPlugin + generateRscManifests) — no hand-written
// registerClientReference / webpack shim.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundleServerGraph, bundleSsrGraph, referencesNodeBuiltins } from "../src/rsc-bundle";
import {
  generateRscManifests,
  RSC_SERVER_MANIFEST_FILE,
  RSC_CLIENT_MANIFEST_FILE,
} from "../src/rsc-manifest";

const REPO = join(import.meta.dir, "..", "..", ".."); // rolldown cwd: node_modules resolves here
const FLIGHT_ENTRY = join(import.meta.dir, "..", "src", "rsc-runtime", "flight-render.tsx");
// Generic SSR entry (flight → html) — used directly for server-only trees.
const SSR_ENTRY_SERVER_ONLY = join(import.meta.dir, "..", "src", "rsc-runtime", "flight-to-html.tsx");
const FIXTURES = join(import.meta.dir, "fixtures", "rsc");
const WITH_ISLAND = join(FIXTURES, "with-island");

let workdir: string;
beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "june-rsc-"));
  // (Re)generate the with-island client-reference manifests — deterministic, so
  // this matches the committed files.
  generateRscManifests(WITH_ISLAND);
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

// Bundle the server graph for an app fixture, run it, return the Flight payload.
async function renderFlightFor(appFixture: string): Promise<{ flight: string; code: string }> {
  const appDir = join(FIXTURES, appFixture);
  const code = await bundleServerGraph(FLIGHT_ENTRY, REPO, join(appDir, "App.tsx"), appDir);
  const file = join(workdir, `flight-${appFixture}.mjs`);
  writeFileSync(file, code);
  const mod = (await import(file)) as { renderFlight: () => Promise<string> };
  return { flight: await mod.renderFlight(), code };
}

describe("generateRscManifests (client-reference codegen)", () => {
  test("scans 'use client' modules → render + consumer manifests keyed by <path>#<export>", () => {
    const dir = mkdtempSync(join(tmpdir(), "june-rscgen-"));
    try {
      mkdirSync(join(dir, "widgets"), { recursive: true });
      writeFileSync(
        join(dir, "widgets", "Counter.tsx"),
        `"use client";\nexport const Counter = () => null;\n`,
      );
      writeFileSync(join(dir, "page.tsx"), `export default function P(){ return null; }\n`); // server, skipped
      const n = generateRscManifests(dir);
      const server = readFileSync(join(dir, RSC_SERVER_MANIFEST_FILE), "utf8");
      const client = readFileSync(join(dir, RSC_CLIENT_MANIFEST_FILE), "utf8");

      expect(n).toBe(1);
      expect(server).toContain('"widgets/Counter#Counter": { id: "widgets/Counter#Counter"');
      expect(client).toContain('import * as m0 from "./widgets/Counter"');
      expect(client).toContain("__webpack_require__");
      expect(client).not.toContain("page"); // server component excluded
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RSC server graph (Flight render)", () => {
  test("a pure server component renders to a worker-safe Flight payload", async () => {
    const { flight, code } = await renderFlightFor("server-only");
    expect(flight).toContain("Server only");
    expect(flight).toContain("pure server content");
    // Worker-safe: the react-server EDGE build pulls no node:* (the deploy-without-
    // our-runtime invariant for Cloudflare/Vercel edge).
    expect(referencesNodeBuiltins(code)).toBe(false);
  }, 30_000);

  test("the plugin auto-rewrites a 'use client' island to a client reference; its server slot children stream as Flight", async () => {
    const { flight } = await renderFlightFor("with-island");
    // Auto-generated reference id (no hand-written registerClientReference).
    expect(flight).toContain('I["Tabs#Tabs"');
    // The server-rendered slot children cross the boundary as the island's children.
    expect(flight).toContain("SERVER overview");
    expect(flight).toContain("SERVER details");
    expect(flight).toContain("data-tab");
  }, 30_000);
});

describe("RSC SSR graph (Flight → HTML)", () => {
  test("a pure server component's Flight renders to worker-safe HTML", async () => {
    const { flight } = await renderFlightFor("server-only");
    const code = await bundleSsrGraph(SSR_ENTRY_SERVER_ONLY, REPO);
    const file = join(workdir, "ssr-server-only.mjs");
    writeFileSync(file, code);
    const mod = (await import(file)) as { flightToHtml: (f: string) => Promise<string> };
    const html = await mod.flightToHtml(flight);
    expect(html).toContain("<h1>Server only</h1>");
    expect(html).toContain("pure server content");
    expect(referencesNodeBuiltins(code)).toBe(false);
  }, 30_000);

  test("a client island SSRs into HTML via the GENERATED manifest — shell + server slot children (full M3)", async () => {
    const { flight } = await renderFlightFor("with-island");
    // The SSR entry imports the generated _rsc-client.gen (webpack shim + moduleMap).
    const code = await bundleSsrGraph(join(WITH_ISLAND, "ssr-entry.tsx"), REPO);
    const file = join(workdir, "ssr-island.mjs");
    writeFileSync(file, code);
    const mod = (await import(file)) as { renderHtml: (f: string) => Promise<string> };
    const html = await mod.renderHtml(flight);
    expect(html).toContain('data-island="tabs"'); // island shell SSR'd
    expect(html).toContain("SERVER overview"); // its server slot children, in HTML
    expect(html).toContain("SERVER details");
    expect(referencesNodeBuiltins(code)).toBe(false);
  }, 30_000);
});
