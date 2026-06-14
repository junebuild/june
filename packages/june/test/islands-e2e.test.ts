// The v0.1 islands acceptance test, end-to-end through the BUILD: `june build`
// emits assets/_june/client.js (production React, NODE_ENV baked), the built worker
// SSRs the island marker, and executing that shipped bundle against that
// shipped markup makes the counter count. This is the milestone criterion —
// "a `"use client"` counter increments in the browser in a built app" — run
// against real build artifacts, not the dev-server path app.test.ts covers.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { juneBuild, buildManifest } from "../src/build";
import { createWorker } from "../src/worker";

const ROOT = fileURLToPath(new URL("../../../examples/basic", import.meta.url));

let outDir: string;
let clientJs: string;
let counterHtml: string;

beforeAll(async () => {
  // Own outDir: build.test.ts owns examples/basic/dist, and this test must not
  // race or clobber its artifacts.
  outDir = await mkdtemp(join(tmpdir(), "june-islands-e2e-"));
  await juneBuild(ROOT, { outDir });
  clientJs = join(outDir, "assets", "_june", "client.js");

  // The page as the BUILT worker serves it (the parity-verified render path).
  const worker = createWorker(await buildManifest(ROOT));
  counterHtml = await (await worker.fetch(new Request("https://e2e.june/counter"))).text();

  GlobalRegistrator.register();
});

afterAll(async () => {
  GlobalRegistrator.unregister();
  await rm(outDir, { recursive: true, force: true });
});

describe("built islands, end to end", () => {
  test('a built "use client" counter increments on click', async () => {
    // Mount the worker-served island subtree exactly as shipped.
    const marker = counterHtml.match(/<june-island[\s\S]*?<\/june-island>/)?.[0];
    expect(marker).toBeTruthy();
    document.body.innerHTML = marker!;

    const button = document.querySelector("june-island button") as HTMLButtonElement;
    expect(button.textContent).toBe("count: 0"); // SSR'd, inert

    // Execute the production bundle the build shipped; it hydrates on load.
    await import(pathToFileURL(clientJs).href);

    // Production React has no act(); hydration + the state update are scheduled
    // asynchronously, so poll: keep clicking until a click lands.
    let counted = false;
    for (let i = 0; i < 200 && !counted; i++) {
      button.click();
      await new Promise((r) => setTimeout(r, 5));
      counted = button.textContent !== "count: 0";
    }
    expect(counted).toBe(true);
  });
});
