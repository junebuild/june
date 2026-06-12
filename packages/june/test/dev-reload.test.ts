// Live reload is a DEV-SERVER wrapper, not a pipeline feature: HTML out of
// startDevServer carries the reload script; the same page out of the bare
// pipeline (what parity tests, what builds) must not. The endpoints answer
// next to the app without shadowing any route.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { loadJuneConfig } from "../src/config-loader";
import { startDevServer, type DevServer } from "../src/dev";

const ROOT = fileURLToPath(new URL("../../../examples/basic", import.meta.url));

let server: DevServer;

beforeAll(async () => {
  server = await startDevServer({ appDir: `${ROOT}/app`, port: 4521 });
});
afterAll(() => server.stop(true));

describe("dev live reload", () => {
  test("dev HTML carries the reload script; the bare pipeline does not", async () => {
    const devHtml = await (await fetch(`${server.url}/`)).text();
    expect(devHtml).toContain('<script src="/__june/reload.js" defer></script>');

    const app = createApp({ appDir: `${ROOT}/app`, config: await loadJuneConfig(ROOT) });
    const pipelineHtml = await (await app.fetch(new Request("https://june.test/"))).text();
    expect(pipelineHtml).not.toContain("/__june/reload.js");
  });

  test("a taken port walks forward instead of dying", async () => {
    // server (beforeAll) holds 4521 — the second server must shift, not fail.
    const second = await startDevServer({ appDir: `${ROOT}/app`, port: 4521 });
    try {
      expect(second.url).not.toBe(server.url);
      expect((await fetch(`${second.url}/`)).status).toBe(200);
    } finally {
      second.stop(true);
    }
  });

  test("the reload endpoints answer; non-HTML responses pass through untouched", async () => {
    const js = await fetch(`${server.url}/__june/reload.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("EventSource");

    const events = await fetch(`${server.url}/__june/events`);
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const reader = events.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: connected");
    await reader.cancel();

    const md = await (await fetch(`${server.url}/users.md`)).text();
    expect(md).not.toContain("__june/reload");
  });
});
