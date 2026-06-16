// Segment-scoped fragments: a layout that exports `segmentBoundary` and renders
// <JuneOutlet> becomes a PERSISTENT SHELL. A soft-nav fragment then renders only
// the content INSIDE the outlet — the shell (sidebar) is excluded from the wire,
// the server render, and the morph. The full document is unaffected (still whole
// chain), so a hard load and the agent surface are identical to before.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { FRAGMENT_ACCEPT, TITLE_HEADER, SEGMENT_HEADER } from "../src/negotiate";

const APP = fileURLToPath(new URL("./fixtures/segment/app", import.meta.url));
const app = createApp({ appDir: APP, config: { clientRouter: true } });

const get = (path: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`http://june.test${path}`, { headers }));

// The inner HTML of the first <div data-june-outlet> in a full document.
function outletInner(html: string): string {
  const open = html.indexOf("data-june-outlet");
  const gt = html.indexOf(">", open);
  // naive but sufficient for the fixture (no nested data-june-outlet)
  const close = html.indexOf("</div>", gt);
  return html.slice(gt + 1, close);
}

describe("segment-scoped fragment", () => {
  test("the fragment is the CONTENT only — the shell/sidebar is excluded", async () => {
    const res = await get("/", { accept: FRAGMENT_ACCEPT });
    expect(res.status).toBe(200);
    expect(res.headers.get(SEGMENT_HEADER)).toBeTruthy(); // a shell key signals segment-scoped
    expect(res.headers.get(TITLE_HEADER)).toBe("Home");
    const frag = await res.text();
    expect(frag).toContain('data-page="home"'); // content is there
    expect(frag).not.toContain("data-sidebar"); // shell is NOT
    expect(frag).not.toContain("data-shell");
    expect(frag).not.toContain("data-june-outlet"); // the outlet wrapper itself is the boundary layout's, not re-sent
  });

  test("the fragment's shell key matches [data-june-root]'s data-june-shell, and is shared across the shell's routes", async () => {
    const full = await (await get("/")).text();
    const key = (await get("/", { accept: FRAGMENT_ACCEPT })).headers.get(SEGMENT_HEADER);
    expect(key).toBeTruthy();
    expect(full).toContain(`data-june-shell="${key}"`); // full load stamps the same key for the client to match
    // routes under the SAME boundary layout carry the SAME key
    const guideKey = (await get("/guide", { accept: FRAGMENT_ACCEPT })).headers.get(SEGMENT_HEADER);
    expect(guideKey).toBe(key);
  });

  test("parity: the fragment equals the full document's [data-june-outlet] inner HTML", async () => {
    const full = await (await get("/")).text();
    const frag = (await (await get("/", { accept: FRAGMENT_ACCEPT })).text()).trim();
    expect(full).toContain("data-june-outlet"); // boundary present on full load
    expect(full).toContain("data-sidebar"); // shell IS in the full document
    expect(outletInner(full).trim()).toBe(frag); // morph target == full-load content region
  });

  test("a hard navigation still gets the whole document (shell + outlet), not segment-scoped", async () => {
    const res = await get("/guide", { accept: "text/html" });
    const html = await res.text();
    expect(res.headers.get(SEGMENT_HEADER)).toBeNull(); // full doc is never segment-scoped
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("data-sidebar"); // shell present
    expect(html).toContain('data-page="guide"'); // content present
  });

  test("only the fragment projection is segment-scoped — markdown stays a full projection", async () => {
    // Segmenting touches renderTarget's fragment branch ONLY; the agent surface
    // (.md/.json/mcp) never carries the SEGMENT header (it's a human-transport
    // concern), so projections are unaffected by the boundary.
    const res = await get("/", { accept: "text/markdown" });
    expect(res.headers.get(SEGMENT_HEADER)).toBeNull();
  });
});
