// The test the PoC was missing. "The dev server never reading june.config.ts
// went unnoticed for days" (rebuild-plan Phase 2). This makes config a
// load-bearing input: a value in the file MUST change observable output.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { loadJuneConfig } from "../src/config-loader";

const APP_DIR = fileURLToPath(new URL("../../../examples/basic/app", import.meta.url));

async function bodyOf(app: ReturnType<typeof createApp>, path: string) {
  return (await app.fetch(new Request(`http://x${path}`))).text();
}

describe("config is read from the app root and reaches output", () => {
  test("the fixture's june.config.ts site name appears in llms.txt", async () => {
    const config = await loadJuneConfig(APP_DIR);
    const app = createApp({ appDir: APP_DIR, config });
    // `# June Basic` comes straight from config.site.name in june.config.ts —
    // proof the dev server actually read the file.
    expect(await bodyOf(app, "/llms.txt")).toContain("# June Basic");
  });
});

describe("changing a config value changes observable output", () => {
  test("site.description flows into the document <meta>", async () => {
    const a = createApp({ appDir: APP_DIR, config: { site: { description: "ALPHA-DESC" } } });
    const b = createApp({ appDir: APP_DIR, config: { site: { description: "BETA-DESC" } } });
    expect(await bodyOf(a, "/")).toContain("ALPHA-DESC");
    expect(await bodyOf(b, "/")).toContain("BETA-DESC");
  });

  test("viewTransitions toggles the @view-transition CSS", async () => {
    const on = createApp({ appDir: APP_DIR, config: { viewTransitions: true } });
    const off = createApp({ appDir: APP_DIR, config: { viewTransitions: false } });
    expect(await bodyOf(on, "/")).toContain("@view-transition");
    expect(await bodyOf(off, "/")).not.toContain("@view-transition");
  });

  test("agent.enabled=false drops the discovery Link header and 404s /mcp", async () => {
    const on = createApp({ appDir: APP_DIR, config: {} }); // on by default
    const off = createApp({ appDir: APP_DIR, config: { agent: { enabled: false } } });

    const onRes = await on.fetch(new Request("http://x/"));
    const offRes = await off.fetch(new Request("http://x/"));
    expect(onRes.headers.get("link")).toContain("llms-txt");
    expect(offRes.headers.get("link")).toBeNull();

    expect((await off.fetch(new Request("http://x/mcp", { method: "POST", body: "{}" }))).status).toBe(404);
  });
});
