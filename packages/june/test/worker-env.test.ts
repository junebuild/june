// Env threading end-to-end: withAssets.fetch(req, env) → createWorker captures
// env → the env-aware worker provider → ctx.db. This proves the DEPLOYED shape:
// the worker's D1 binding reaches the route. (The dev/local-sqlite half is
// resources.test.ts; this is the prod path.)
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { buildManifest } from "../src/build";
import { createWorker, withAssets } from "../src/worker";
import { bindWorkerResources } from "../src/resources";
import type { D1Database } from "../src/db";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/db", import.meta.url));
const ORIGIN = "http://june.test";

// A D1 binding that answers the fixture's `select name from users` with edge data.
function fakeD1(): D1Database {
  return {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        all: async <T>() => ({ results: [{ name: "FromD1" }] as T[] }),
        first: async <T>() => ({ name: "FromD1" }) as T,
        run: async () => ({ meta: { changes: 0, last_row_id: 0 } }),
      };
      void sql;
      return stmt;
    },
    exec: async () => ({}),
  };
}

const jsonAt = async (
  worker: ReturnType<typeof withAssets>,
  path: string,
  env?: unknown,
) => (await worker.fetch(new Request(ORIGIN + path), env as never)).json();

const statusAt = async (
  worker: ReturnType<typeof withAssets>,
  path: string,
  env?: unknown,
) => (await worker.fetch(new Request(ORIGIN + path), env as never)).status;

describe("worker env → ambient db", () => {
  test("env.DB present → ambient db is the D1 binding (production path)", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    manifest.resources = bindWorkerResources({ db: true });
    const worker = withAssets(createWorker(manifest));

    expect(await jsonAt(worker, "/index.json", { DB: fakeD1() })).toEqual({
      users: [{ name: "FromD1" }],
    });
  });

  test("no env binding → ambient db unbound → load 404s (no silent empty at the edge)", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    manifest.resources = bindWorkerResources({ db: true });
    const worker = withAssets(createWorker(manifest));

    expect(await statusAt(worker, "/index.json")).toBe(404);
  });

  test("no resources provider → ambient db throws → load 404s (env ignored)", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    const worker = withAssets(createWorker(manifest));
    expect(await statusAt(worker, "/index.json", { DB: fakeD1() })).toBe(404);
  });
});
