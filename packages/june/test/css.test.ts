// CSS: the auto-link convention. app/global.css → dev serves /global.css and the
// document <link>s it; no global.css → no link (parity). processCss passes plain
// CSS through; the build emits dist/assets/global.css.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { processCss, findGlobalCss, STYLES_URL } from "../src/css";

const CSS_APP = fileURLToPath(new URL("./fixtures/css/app", import.meta.url));
const NOCSS_APP = fileURLToPath(new URL("./fixtures/db/app", import.meta.url)); // has no global.css

describe("global.css auto-link", () => {
  test("app/global.css → /global.css is served as text/css", async () => {
    const app = createApp({ appDir: CSS_APP, config: {} });
    const res = await app.fetch(new Request("http://june.test/global.css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain("rebeccapurple");
  });

  test("the document links it after the inline base styles", async () => {
    const app = createApp({ appDir: CSS_APP, config: {} });
    const html = await (await app.fetch(new Request("http://june.test/"))).text();
    expect(html).toContain(`<link rel="stylesheet" href="${STYLES_URL}"`);
    // it comes AFTER the inline <style> so it (and a Tailwind reset) wins
    expect(html.indexOf("</style>")).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  test("no app/global.css → no stylesheet link (zero-config, parity-safe)", async () => {
    expect(findGlobalCss(NOCSS_APP)).toBeNull();
    const app = createApp({ appDir: NOCSS_APP, config: {} });
    const html = await (await app.fetch(new Request("http://june.test/"))).text();
    expect(html).not.toContain('rel="stylesheet"');
  });

  test("processCss passes plain CSS through unchanged", async () => {
    expect(await processCss(CSS_APP)).toContain("rebeccapurple");
    expect(await processCss(NOCSS_APP)).toBeNull();
  });
});
