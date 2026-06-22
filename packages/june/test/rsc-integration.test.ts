// RSC integration — buildRsc emits a worker that serves the RSC app as a full
// <Document> HTML response, on a STANDARD target (worker-safe, no native runtime).
// Builds for real, then invokes the emitted worker's fetch().
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRsc, findRscEntry } from "../src/rsc-build";
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

describe("buildRsc", () => {
  test("opt-in: detects app/_rsc.tsx", () => {
    expect(findRscEntry(join(APP_ROOT, "app"))).toBeTruthy();
    expect(findRscEntry(join(import.meta.dir, "fixtures", "rsc"))).toBeUndefined();
  });

  test("builds an RSC worker that serves a full Document with the island SSR'd", async () => {
    // cwd = APP_ROOT (inside the repo) so rolldown resolves node_modules; outputs
    // go to a temp dir. Regenerates the (deterministic) committed manifests.
    const result = await buildRsc(APP_ROOT, out, DOC_CONFIG);
    expect(result).not.toBeNull();

    const worker = (await import(join(out, result!.worker))) as {
      default: { fetch: (r: Request) => Promise<Response> };
    };
    const res = await worker.default.fetch(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    // Full document shell (Document wrapped it).
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("<title>RSC</title>"); // from DOC_CONFIG.site.name
    // Server content + the client island SSR'd through Flight, with its server slot.
    expect(html).toContain("RSC app root");
    expect(html).toContain('data-island="tabs"');
    expect(html).toContain("SERVER overview");
  }, 60_000);
});
