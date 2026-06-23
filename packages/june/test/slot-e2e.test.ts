// Slot islands, end-to-end through the BUILD: the production worker SSRs the slot
// island (interactive shell + zero-JS content + a nested island), and the shipped
// client.js hydrates the shell, preserves the server content verbatim, and lets the
// nested island self-hydrate. Exercises the REAL bundle (production React, async
// hydration), not the act()/happy-dom unit path — the edge the reviewer flagged as
// "demo passes, edge combos explode".
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { juneBuild, buildManifest } from "../src/build";
import { createWorker } from "../src/worker";

const ROOT = fileURLToPath(new URL("../../../examples/basic", import.meta.url));

let outDir: string;
let clientJs: string;
let slotBody: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "june-slot-e2e-"));
  await juneBuild(ROOT, { outDir });
  const juneDir = join(outDir, "assets", "_june");
  const hashed = (await readdir(juneDir)).find((f) => /^client\.[a-f0-9]{8}\.js$/.test(f))!;
  clientJs = join(juneDir, hashed);

  const worker = createWorker(await buildManifest(ROOT));
  const html = await (await worker.fetch(new Request("https://e2e.june/slot"))).text();
  // Strip the client.js loader <script> (happy-dom would try to fetch it on innerHTML).
  slotBody = (html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");

  GlobalRegistrator.register();
});

afterAll(async () => {
  GlobalRegistrator.unregister();
  await rm(outDir, { recursive: true, force: true });
});

describe("built slot island, end to end", () => {
  test("shell hydrates, server content stays, nested island counts", async () => {
    document.body.innerHTML = slotBody;

    // SSR: the slot marker carries the server content (zero-JS) including the nested marker.
    const shell = document.querySelector("june-island[data-june-slot]") as HTMLElement;
    expect(shell).toBeTruthy();
    expect(document.querySelector("june-slot")).toBeTruthy();
    const frozen = [...document.querySelectorAll("june-slot p")].find((p) => p.textContent?.includes("server HTML"));
    expect(frozen).toBeTruthy();
    const nested = document.querySelector('june-island[data-june-island="Counter"] button') as HTMLButtonElement;
    expect(nested.textContent).toBe("count: 0"); // SSR'd, inert

    // Execute the shipped production bundle — it hydrates on load.
    await import(pathToFileURL(clientJs).href);

    // The nested island inside the slot self-hydrates and counts.
    let counted = false;
    for (let i = 0; i < 200 && !counted; i++) {
      nested.click();
      await sleep(5);
      counted = nested.textContent !== "count: 0";
    }
    expect(counted).toBe(true);

    // The frozen server content is still there verbatim (never reconciled away).
    expect([...document.querySelectorAll("june-slot p")].some((p) => p.textContent?.includes("server HTML"))).toBe(true);

    // The shell chrome is live: its toggle button flips the content's [hidden].
    const toggle = [...document.querySelectorAll("june-island[data-june-slot] button")].find((b) =>
      /details/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    const panelBody = toggle.parentElement!.querySelector("div");
    const before = (panelBody as HTMLElement).hidden;
    for (let i = 0; i < 200; i++) {
      toggle.click();
      await sleep(5);
      if ((panelBody as HTMLElement).hidden !== before) break;
    }
    expect((panelBody as HTMLElement).hidden).toBe(!before); // shell state toggled the content
  });
});
