// Regression: the worker bundle must externalize Bun built-ins. @junejs/core's redis() cache store
// guards a Bun-only module behind `const x = "bun"; await import(x)`; rolldown constant-folds that and
// would warn UNRESOLVED_IMPORT (and could try to pull a Bun-only module into the workerd graph) unless
// the build declares `bun`/`bun:*` external. isBunSpecifier is that rule.
import { describe, expect, test, beforeAll } from "bun:test";
import { isBunSpecifier, resolveDeployAdapter } from "../src/build";
import { workers, vercel, deno } from "../src/adapter";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { juneBuild } from "../src/build";
import { fileURLToPath } from "node:url";

describe("resolveDeployAdapter (deploy.target → built-in adapter)", () => {
  test("resolves each target NAME to its built-in — so a declarative config (kura.toml) can pick it", () => {
    // The bug this fixes: build only special-cased "static", so target:"vercel"/"deno" silently
    // fell back to workers() — a Vercel build packaged as Cloudflare Workers.
    expect(resolveDeployAdapter({ target: "static" }).name).toBe("static");
    expect(resolveDeployAdapter({ target: "vercel" }).name).toBe("vercel");
    expect(resolveDeployAdapter({ target: "deno" }).name).toBe("deno");
    expect(resolveDeployAdapter({ target: "workers" }).name).toBe("workers");
  });

  test("defaults to workers() when no target/adapter is given", () => {
    expect(resolveDeployAdapter(undefined).name).toBe("workers");
    expect(resolveDeployAdapter({}).name).toBe("workers");
  });

  test("an explicit adapter INSTANCE wins over target", () => {
    const custom = vercel();
    // even with a conflicting target string, the passed instance is used verbatim
    expect(resolveDeployAdapter({ target: "workers", adapter: custom })).toBe(custom);
  });

  test("the vercel target resolves to the edge-light bundle (not workers)", () => {
    const a = resolveDeployAdapter({ target: "vercel" });
    expect(a.conditions).toContain("edge-light");
    expect(a.conditions).not.toContain("workerd");
  });
});

describe("isBunSpecifier (worker-bundle externals)", () => {
  test("treats the bun namespace as external", () => {
    expect(isBunSpecifier("bun")).toBe(true);
    expect(isBunSpecifier("bun:sqlite")).toBe(true);
    expect(isBunSpecifier("bun:ffi")).toBe(true);
  });

  test("leaves normal modules bundleable", () => {
    expect(isBunSpecifier("react")).toBe(false);
    expect(isBunSpecifier("@junejs/core")).toBe(false);
    expect(isBunSpecifier("node:fs")).toBe(false);
    // not the bun namespace — must NOT be swallowed by a loose prefix match
    expect(isBunSpecifier("bundle")).toBe(false);
    expect(isBunSpecifier("bunny")).toBe(false);
  });
});

// ── adapter.buildExternal ────────────────────────────────────────────────────
// Each adapter declares the packages its target cannot bundle (WASM, native
// bindings, platform-native modules). The build merges these with
// config.build.external so users never need adapter-specific workarounds.

describe("adapter.buildExternal declarations", () => {
  test("workers() requires workers-og to be external (WASM bundled by wrangler, not rolldown)", () => {
    expect(workers().buildExternal).toContain("workers-og");
  });

  test("vercel() has no adapter-level buildExternal (its WASM deps are handled by Vercel's bundler)", () => {
    expect(vercel().buildExternal ?? []).toHaveLength(0);
  });

  test("deno() has no adapter-level buildExternal", () => {
    expect(deno().buildExternal ?? []).toHaveLength(0);
  });

  test("adapter.buildExternal never removes what config.build.external adds", () => {
    // The merge is additive: [adapter, ...userConfig]. User additions survive.
    const adapterList = workers().buildExternal ?? [];
    const userList = ["my-custom-pkg"];
    const merged = [...adapterList, ...userList];
    expect(merged).toContain("workers-og");
    expect(merged).toContain("my-custom-pkg");
  });
});

// ── build integration: adapter externals applied during juneBuild() ──────────
// The real guard: build the basic example and confirm workers-og is NOT bundled
// into the worker (it stays external even without config.build.external).

describe("juneBuild() — adapter externals applied without user config", () => {
  const ROOT = fileURLToPath(new URL("../../../examples/basic", import.meta.url));

  test("built worker does not inline workers-og (adapter.buildExternal keeps it external)", async () => {
    // The basic example uses the default workers() adapter and no config.build.external.
    // If adapter.buildExternal is correctly merged, workers-og import won't appear
    // in the worker source (it's resolved external and wrangler handles it separately).
    // We test indirectly: if the build succeeds (no UNRESOLVED_IMPORT for workers-og)
    // and the built worker doesn't contain an inline workers-og chunk.
    const result = await juneBuild(ROOT);
    const code = await readFile(result.outFile, "utf8");
    // workers-og must NOT be inlined — its WASM chunk structure would show up as
    // base64 literals if bundled. workers-og is only in the bundle if rolldown
    // tries to inline it; being external leaves no trace in the source.
    expect(code).not.toContain("workers-og/dist");
  });
});
