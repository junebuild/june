// useLoaderData() — the escape-hatch hook that reads the SAME loader data the
// view gets as props, for deep children (and the Remix muscle-memory). Canonical
// stays props; this proves both coexist from one loader, server-rendered.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";

const APP_DIR = fileURLToPath(new URL("./fixtures/hook/app", import.meta.url));

const html = async (path: string) => {
  const app = createApp({ appDir: APP_DIR, config: {} });
  return (await app.fetch(new Request(`http://june.test${path}`))).text();
};

describe("useLoaderData", () => {
  test("props (top view) and the hook (deep child) read the same loader data", async () => {
    const out = await html("/");
    // Canonical props path: the h1.
    expect(out).toContain('data-props="true"');
    expect(out).toMatch(/<h1[^>]*>hook-and-props<\/h1>/);
    // Escape-hatch hook path: a nested component, no prop drilling.
    expect(out).toMatch(/<span data-deep="true">hook-and-props<\/span>/);
  });

  test(".json still derives from the loader (the view's hook does not change projections)", async () => {
    const app = createApp({ appDir: APP_DIR, config: {} });
    const json = await (await app.fetch(new Request("http://june.test/.json"))).json();
    expect(json).toEqual({ greeting: "hook-and-props" });
  });
});
