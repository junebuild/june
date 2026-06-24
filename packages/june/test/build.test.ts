// `june build` produces a workerd-ready bundle from the fixture, and the
// prerendered output renders THROUGH the worker — so what ships is what the
// parity test verified. Runs the real Rolldown build once (≈1.5s).

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { juneBuild, workerName, type BuildResult } from "../src/build";
import { juneDeploy } from "../src/deploy";

describe("workerName (wrangler-valid name from a package/dir name)", () => {
  test("a SCOPED package name drops its scope (no leading dash → wrangler accepts it)", () => {
    expect(workerName("@kurajs/example-docs")).toBe("example-docs"); // was "-kurajs-example-docs"
    expect(workerName("@acme/My App")).toBe("my-app");
  });
  test("plain names pass through; punctuation collapses; edges trim; empty → fallback", () => {
    expect(workerName("website")).toBe("website");
    expect(workerName("My_Cool.Site")).toBe("my-cool-site");
    expect(workerName("--weird--")).toBe("weird");
    expect(workerName("@scope/___")).toBe("app");
  });
  test("the result is always a valid wrangler worker name", () => {
    const ok = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
    for (const n of ["@kurajs/example-docs", "website", "@a/b c", "...", "Foo"]) {
      expect(workerName(n)).toMatch(ok);
    }
  });
});
import { createApp } from "../src/app";
import { loadJuneConfig } from "../src/config-loader";

const ROOT = fileURLToPath(new URL("../../../examples/basic", import.meta.url));
const DIST = join(ROOT, "dist");

let result: BuildResult;

beforeAll(async () => {
  result = await juneBuild(ROOT);
});

describe("juneBuild()", () => {
  test("reports the frozen route + content shape", () => {
    expect(result.routes).toContain("/");
    expect(result.routes).toContain("/users");
    expect(result.dynamicRoutes).toContain("/posts/[slug]");
    expect(result.contentCollections).toContain("posts");
    expect(result.prerendered).toContain("/");
  });

  test("emits a self-contained worker bundle", async () => {
    expect(existsSync(result.outFile)).toBe(true);
    const code = await readFile(result.outFile, "utf8");
    expect(code.length).toBeGreaterThan(1000);
    // The worker graph must not statically import node:* (reminder #4): the only
    // host touch is cache's non-literal "bun" specifier, left external.
    expect(/from\s*["']node:/.test(code)).toBe(false);
  });

  test("writes a wrangler config with nodejs_compat + assets", async () => {
    const wrangler = JSON.parse(await readFile(join(DIST, "wrangler.jsonc"), "utf8"));
    expect(wrangler.main).toBe("./worker.js");
    expect(wrangler.compatibility_flags).toContain("nodejs_compat");
    expect(wrangler.assets.directory).toBe("./assets");
  });

  test("prerenders / THROUGH the worker — render-equivalent to the dev home", async () => {
    const indexHtml = await readFile(join(DIST, "assets", "index.html"), "utf8");
    expect(indexHtml).toContain(`<meta charSet="utf-8"/>`);
    expect(indexHtml).toContain("Hello from June");

    const dev = createApp({ appDir: join(ROOT, "app"), config: await loadJuneConfig(ROOT) });
    const devHome = await (await dev.fetch(new Request("https://prerender.june/"))).text();
    // Render structure is identical; only the hashed asset HREFs differ (build
    // hashes for immutable caching, dev keeps stable URLs). Normalize the hash
    // out and the documents are byte-equal — parity is about render, not caching.
    const unhash = (h: string) => h.replace(/\/_june\/(client|global)\.[a-f0-9]{8}\.(js|css)/g, "/_june/$1.$2");
    expect(unhash(indexHtml)).toBe(devHome);
  });

  test("bundles app/_client.tsx into a content-hashed /_june/client.<hash>.js (NODE_ENV baked)", async () => {
    const name = (await readdir(join(DIST, "assets", "_june"))).find((f) => /^client\.[a-f0-9]{8}\.js$/.test(f));
    expect(name).toBeTruthy(); // hashed, not the stable dev name
    const clientJs = await readFile(join(DIST, "assets", "_june", name!), "utf8");
    expect(clientJs).toContain("june-island"); // the hydration runtime is in there
    expect(clientJs).not.toContain("process.env.NODE_ENV"); // browsers have no process
  });

  test("the frozen document loads the hashed client bundle (prerendered pages included)", async () => {
    const indexHtml = await readFile(join(DIST, "assets", "index.html"), "utf8");
    expect(indexHtml).toMatch(/<script type="module" src="\/_june\/client\.[a-f0-9]{8}\.js">/);
  });

  test("the bundled worker executes and serves /", async () => {
    const mod = (await import(`${result.outFile}?t=${result.routes.length}`)) as {
      default: { fetch(r: Request): Promise<Response> };
    };
    const res = await mod.default.fetch(new Request("https://june.test/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hello from June");
  });
});

describe("juneDeploy()", () => {
  test("rejects an unknown deploy target before any build/wrangler call", async () => {
    // The target check is the adapter seam: it runs FIRST, so an invalid target
    // throws without touching the network — that is what we assert (a real
    // wrangler --dry-run needs network + auth and isn't a unit test).
    const dir = await mkdtemp(join(tmpdir(), "june-deploy-"));
    await writeFile(join(dir, "june.config.js"), `export default { deploy: { target: "bogus" } };\n`);
    await expect(juneDeploy(dir)).rejects.toThrow("unknown deploy target: bogus");
  });
});
