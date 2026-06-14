// The `fragment` projection (Route A): a soft-nav/live transport returning the
// [data-june-root] inner HTML for the SAME url, signaled by the fragment media
// type. The parity contract: the fragment is byte-identical to what a full load
// puts inside [data-june-root] (so morphing it yields the same DOM), with the
// title in a header and NO document shell.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { FRAGMENT_ACCEPT, TITLE_HEADER } from "../src/negotiate";

const APP = fileURLToPath(new URL("./fixtures/router/app", import.meta.url));
const app = createApp({ appDir: APP, config: { clientRouter: true } });

const get = (path: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`http://june.test${path}`, { headers }));

describe("fragment projection", () => {
  test("returns the bare view fragment (no document shell) + title header", async () => {
    const res = await get("/", { accept: FRAGMENT_ACCEPT });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get(TITLE_HEADER)).toBe("Home"); // page metadata.title
    const frag = await res.text();
    expect(frag).toContain('data-page="home"'); // the view content is there
    expect(frag).not.toContain("<html"); // NO document shell
    expect(frag).not.toContain("<head"); // NO head
    expect(frag).not.toContain("<title"); // title is a header, not in the body
  });

  test("parity: the fragment is byte-identical to the full page's [data-june-root]", async () => {
    const full = await (await get("/")).text();
    const frag = (await (await get("/", { accept: FRAGMENT_ACCEPT })).text()).trim();
    // [data-june-root] wraps exactly the chain-wrapped view, which is what the
    // fragment renders — so the fragment is a verbatim slice of the full document.
    expect(full).toContain("data-june-root"); // clientRouter on → the region exists
    expect(full).toContain(frag); // morph target == full-load content
  });

  test("an island renders identically in the fragment (opaque, hydrates the same)", async () => {
    const full = await (await get("/")).text();
    const frag = await (await get("/", { accept: FRAGMENT_ACCEPT })).text();
    const island = /<june-island[\s\S]*?<\/june-island>/;
    expect(frag).toMatch(island); // the island marker is in the fragment
    // same island markup in both → re-hydration after morph is identical
    expect(full.match(island)?.[0]).toBe(frag.match(island)?.[0]);
  });

  test("a normal browser navigation still gets the full document, not a fragment", async () => {
    const res = await get("/", { accept: "text/html" });
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(res.headers.get(TITLE_HEADER)).toBeNull(); // no fragment header
  });
});
