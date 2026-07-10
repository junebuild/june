// The public/ directory end-to-end: dev serves it (app.ts), build copies it into
// dist/assets (build.ts), the Deno runtime serves it (withDenoAssets), and the
// Vercel adapter places it on the static tier. examples/basic ships a public/
// (logo.svg + images/pixel.png) that doubles as the fixture here.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { juneBuild } from "../src/build";
import { vercel } from "../src/adapter";
import { withDenoAssets } from "../src/worker";

const BASIC = fileURLToPath(new URL("../../../examples/basic", import.meta.url));
const APP_DIR = join(BASIC, "app");

describe("dev: app.ts serves public/ verbatim, before the pipeline", () => {
  const app = createApp({ appDir: APP_DIR, config: {} });

  test("a public file is served with the right content-type", async () => {
    const res = await app.fetch(new Request("http://x/logo.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    // Never immutable — public files are not content-hashed.
    expect(res.headers.get("cache-control")).not.toContain("immutable");
    expect(await res.text()).toContain("<svg");
  });

  test("a nested public file resolves through subdirectories", async () => {
    const res = await app.fetch(new Request("http://x/images/pixel.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("HEAD returns headers (incl. content-length) but no body, without reading the file", async () => {
    const res = await app.fetch(new Request("http://x/logo.svg", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    // content-length comes from the stat size (no body read for HEAD).
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  test("a symlink under public/ is NOT followed (no escape, dev/prod parity)", async () => {
    // A symlink pointing outside public/ must not serve its target in dev — the
    // build (collectFiles → Dirent.isFile()) drops symlinks, so dev matches it,
    // and a hostile template can't exfiltrate a file via `june dev`.
    const link = join(BASIC, "public", "escape.json");
    symlinkSync(join(BASIC, "package.json"), link); // target lives outside public/
    try {
      const res = await app.fetch(new Request("http://x/escape.json"));
      expect(res.status).toBe(404); // fell through — symlink ignored
      const body = await res.text();
      expect(body).not.toContain("@june-examples/basic"); // did NOT leak package.json
    } finally {
      unlinkSync(link);
    }
  });

  test("a missing public file falls through to the render pipeline (not a public 200)", async () => {
    const res = await app.fetch(new Request("http://x/does-not-exist.png"));
    // The pipeline 404-renders HTML — proof we fell through instead of serving bytes.
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("a public subdirectory path is not served as a file (falls through)", async () => {
    // /images is a directory → statSync().isFile() is false → the pipeline, not a
    // 200 of directory bytes. Also exercises the fs-error-tolerant stat path.
    const res = await app.fetch(new Request("http://x/images"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("build: public/ is copied into dist/assets (reserved _june/ skipped)", () => {
  // A dedicated fixture — NOT examples/basic — because juneBuild mutates its
  // app root (.june/, app/_content.ts, wrangler.jsonc), and building the shared
  // example from two test files races. This fixture is built only here.
  const RESERVED = fileURLToPath(new URL("./fixtures/public-reserved", import.meta.url));
  let outDir: string | undefined;
  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
    await rm(join(RESERVED, "wrangler.jsonc"), { force: true });
    await rm(join(RESERVED, ".june"), { recursive: true, force: true });
  });

  test("copies public files (incl. nested), skips the reserved _june/ segment", async () => {
    outDir = await mkdtemp(join(tmpdir(), "june-public-"));
    await juneBuild(RESERVED, { outDir });
    const asset = (...p: string[]) => existsSync(join(outDir!, "assets", ...p));
    expect(asset("ok.txt")).toBe(true); // top-level file copied
    expect(asset("images", "pixel.png")).toBe(true); // nested file copied
    expect(asset("_june", "evil.js")).toBe(false); // reserved → skipped (never clobbers framework assets)
  });
});

describe("deno: withDenoAssets serves public files (non-immutable) via the co-located assets/", () => {
  const realDeno = (globalThis as Record<string, unknown>).Deno;
  test("a public file is served with must-revalidate; _june stays immutable", async () => {
    (globalThis as Record<string, unknown>).Deno = {
      readFile: async (p: URL) => {
        const s = p.toString();
        if (s.endsWith("/assets/logo.svg")) return new TextEncoder().encode("<svg/>");
        if (s.endsWith("/assets/_june/app.abc12345.js")) return new TextEncoder().encode("x");
        // An extensionless public file (Apple universal-links manifest).
        if (s.endsWith("/assets/.well-known/apple-app-site-association")) return new TextEncoder().encode("{}");
        // A filename containing a reserved char must arrive percent-encoded per
        // segment (else `?` would start a query and read the wrong file).
        if (s.endsWith("/assets/a%3Fb.txt")) return new TextEncoder().encode("q");
        throw new Error("ENOENT");
      },
    };
    try {
      const pipeline = { fetch: async () => new Response("rendered") };
      const handler = withDenoAssets(pipeline);

      const pub = await handler(new Request("http://x/logo.svg"));
      expect(pub.status).toBe(200);
      expect(pub.headers.get("content-type")).toBe("image/svg+xml");
      expect(pub.headers.get("cache-control")).toContain("must-revalidate");
      expect(pub.headers.get("cache-control")).not.toContain("immutable");

      const fw = await handler(new Request("http://x/_june/app.abc12345.js"));
      expect(fw.headers.get("cache-control")).toContain("immutable");

      // A percent-encoded separator decodes to the SAME hashed asset — immutable
      // is derived from the canonical rel, so it must still be immutable.
      const enc = await handler(new Request("http://x/_june%2Fapp.abc12345.js"));
      expect(enc.status).toBe(200);
      expect(enc.headers.get("cache-control")).toContain("immutable");

      // A `?` in a filename (arrives as %3F) is served — segments are re-encoded
      // when building the asset URL, so `?` doesn't start a query.
      const q = await handler(new Request("http://x/a%3Fb.txt"));
      expect(q.status).toBe(200);
      expect(await q.text()).toBe("q");

      // Extensionless public file → served on Deno too (cross-target verbatim
      // contract), NOT 404'd for lacking an extension.
      const aasa = await handler(new Request("http://x/.well-known/apple-app-site-association"));
      expect(aasa.status).toBe(200);
      expect(await aasa.text()).toBe("{}");

      // An extensionless path with no matching file → falls through to the pipeline.
      expect(await (await handler(new Request("http://x/about"))).text()).toBe("rendered");
    } finally {
      (globalThis as Record<string, unknown>).Deno = realDeno;
    }
  });
});

describe("vercel: publicFiles are copied to the static tier", () => {
  test("emit places public files (incl. nested) under .vercel/output/static", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "june-vc-public-"));
    try {
      const outDir = join(appRoot, "dist");
      await mkdir(join(outDir, "assets", "images"), { recursive: true });
      await writeFile(join(outDir, "worker.js"), "export default () => new Response('ok')");
      await writeFile(join(outDir, "assets", "logo.svg"), "<svg/>");
      await writeFile(join(outDir, "assets", "images", "pixel.png"), "PNG");

      await vercel().emit({
        appRoot,
        outDir,
        hasAssets: true,
        linkHeader: null,
        config: {},
        plan: {},
        defaultName: "d",
        publicFiles: ["logo.svg", "images/pixel.png"],
      });

      const staticDir = join(appRoot, ".vercel", "output", "static");
      expect(existsSync(join(staticDir, "logo.svg"))).toBe(true);
      expect(existsSync(join(staticDir, "images", "pixel.png"))).toBe(true);
      expect(await readFile(join(staticDir, "logo.svg"), "utf8")).toBe("<svg/>");
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });
});
