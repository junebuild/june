// Cross-island store, end-to-end through the BUILD. The real test isn't the hook
// (unit-tested) — it's whether the BUNDLER keeps the store a single shared instance
// across two island chunks. If rolldown duplicated cart-store into each island's
// chunk, the two islands would hold SEPARATE stores and the badge would never update.
// This proves the shipped bundle shares it: clicking AddToCart (one island) updates
// CartBadge (another island).
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
let cartBody: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "june-store-e2e-"));
  await juneBuild(ROOT, { outDir });
  const juneDir = join(outDir, "assets", "_june");
  const hashed = (await readdir(juneDir)).find((f) => /^client\.[a-f0-9]{8}\.js$/.test(f))!;
  clientJs = join(juneDir, hashed);

  const worker = createWorker(await buildManifest(ROOT));
  const html = await (await worker.fetch(new Request("https://e2e.june/cart"))).text();
  cartBody = (html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");

  GlobalRegistrator.register();
});

afterAll(async () => {
  GlobalRegistrator.unregister();
  await rm(outDir, { recursive: true, force: true });
});

describe("built cross-island store, end to end", () => {
  test("AddToCart (one island) updates CartBadge (another) via the shared store", async () => {
    document.body.innerHTML = cartBody;
    const badge = document.querySelector("[data-cart-count]") as HTMLElement;
    expect(badge.textContent).toBe("cart: 0"); // SSR snapshot = initial

    await import(pathToFileURL(clientJs).href); // hydrates both islands

    const add = [...document.querySelectorAll("button")].find((b) => /Add/i.test(b.textContent ?? "")) as HTMLButtonElement;
    expect(add).toBeTruthy();

    let updated = false;
    for (let i = 0; i < 200 && !updated; i++) {
      add.click();
      await sleep(5);
      updated = badge.textContent !== "cart: 0";
    }
    expect(updated).toBe(true); // the OTHER island re-rendered → one shared store in the bundle
  });
});
