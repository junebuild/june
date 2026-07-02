// juneDeploy orchestration — the NEW migrate-before-deploy wiring and its gates.
// Both side effects (the D1 transport and the wrangler-deploy spawn) are injected,
// so this drives the real control flow with no wrangler and no network. The risky
// invariants: --dry-run never touches remote D1, and a destructive migration
// halts BEFORE the worker ships.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { juneDeploy } from "../src/deploy";
import type { D1Exec } from "../src/d1-migrate";

const DB_APP = fileURLToPath(new URL("./fixtures/deploy-db", import.meta.url));
const NODB_APP = fileURLToPath(new URL("./fixtures/deploy-nodb", import.meta.url));
const VERCEL_APP = fileURLToPath(new URL("./fixtures/vercel-app", import.meta.url));
const DENO_APP = fileURLToPath(new URL("./fixtures/deno-app", import.meta.url));
const STATIC_APP = fileURLToPath(new URL("./fixtures/static-app", import.meta.url));

// Records the ordered sequence of side effects so we can assert "migrate, THEN
// deploy" and "deploy never happened".
function harness() {
  const events: string[] = [];
  const ledger = new Set<string>();
  const d1Exec: D1Exec = async ({ sql, mode }) => {
    const low = sql.trim().toLowerCase();
    if (low.startsWith("select id from _june_migrations")) {
      events.push("migrate:read");
      return {
        stdout: JSON.stringify([{ results: [...ledger].map((id) => ({ id })), meta: {} }]),
        stderr: "",
        exitCode: 0,
      };
    }
    if (low.startsWith("insert into _june_migrations")) {
      const m = sql.match(/values\s*\(\s*'([^']*)'/i);
      if (m?.[1]) ledger.add(m[1]);
      return { stdout: JSON.stringify([{ results: [], meta: { changes: 1 } }]), stderr: "", exitCode: 0 };
    }
    if (mode === "file" && !low.startsWith("create table if not exists _june_migrations")) {
      events.push("migrate:exec");
    }
    return { stdout: JSON.stringify([{ results: [], meta: {} }]), stderr: "", exitCode: 0 };
  };
  const runCli = async (args: string[]) => {
    const tool = args[1]?.startsWith("vercel") ? "vercel" : "deploy";
    events.push(`${tool}${args.includes("--dry-run") ? ":dry" : ""}`);
    const url = tool === "vercel" ? "https://june-cake.vercel.app" : "https://deploytest.workers.dev";
    return { stdout: `Deployed\n${url}`, stderr: "", exitCode: 0 };
  };
  return { events, ledger, d1Exec, runCli };
}

describe("juneDeploy orchestration", () => {
  test("db app: migrates D1 BEFORE deploying, reports applied migrations", async () => {
    const h = harness();
    const r = await juneDeploy(DB_APP, {
      skipBuild: true,
      allowDestructive: true, // so the destructive 0002 doesn't halt this happy path
      d1Exec: h.d1Exec,
      runCli: h.runCli,
    });
    expect(r.migrated).toEqual(["0001_init.sql", "0002_drop.sql"]);
    expect(r.url).toBe("https://deploytest.workers.dev");
    // the migrate work all precedes the single deploy
    expect(h.events[h.events.length - 1]).toBe("deploy");
    expect(h.events.indexOf("migrate:exec")).toBeLessThan(h.events.indexOf("deploy"));
  });

  test("--dry-run never touches remote D1 (migration skipped), still validates deploy", async () => {
    const h = harness();
    const r = await juneDeploy(DB_APP, {
      skipBuild: true,
      dryRun: true,
      d1Exec: h.d1Exec,
      runCli: h.runCli,
    });
    expect(r.migrated).toEqual([]);
    expect(h.events).toEqual(["deploy:dry"]); // no migrate:* events at all
  });

  test("destructive migration HALTS before deploy (no consent)", async () => {
    const h = harness();
    await expect(
      juneDeploy(DB_APP, { skipBuild: true, d1Exec: h.d1Exec, runCli: h.runCli }),
    ).rejects.toThrow(/destructive.*DROP TABLE/s);
    expect(h.events).not.toContain("deploy"); // the worker was never shipped
    expect(h.events).not.toContain("deploy:dry");
  });

  test("--skip-migrate bypasses migration but still deploys", async () => {
    const h = harness();
    const r = await juneDeploy(DB_APP, {
      skipBuild: true,
      skipMigrate: true,
      d1Exec: h.d1Exec,
      runCli: h.runCli,
    });
    expect(r.migrated).toEqual([]);
    expect(h.events).toEqual(["deploy"]);
  });

  test("app with no db resource: skips migration entirely", async () => {
    const h = harness();
    const r = await juneDeploy(NODB_APP, {
      skipBuild: true,
      d1Exec: h.d1Exec,
      runCli: h.runCli,
    });
    expect(r.migrated).toEqual([]);
    expect(h.events).toEqual(["deploy"]); // migrate never invoked
  });
});

describe("juneDeploy → vercel target", () => {
  // vercel-app's config uses the vercel adapter → deploy dispatches to the Vercel
  // path. Stand in a prebuilt Build Output so skipBuild works.
  afterEach(async () => {
    await rm(join(VERCEL_APP, ".vercel"), { recursive: true, force: true });
  });
  const stubOutput = async () => {
    await mkdir(join(VERCEL_APP, ".vercel", "output"), { recursive: true });
    await writeFile(join(VERCEL_APP, ".vercel", "output", "config.json"), '{"version":3,"routes":[]}');
  };

  test("uploads the prebuilt output via vercel — never wrangler, never D1", async () => {
    await stubOutput();
    const h = harness();
    const r = await juneDeploy(VERCEL_APP, { skipBuild: true, runCli: h.runCli });
    expect(h.events).toEqual(["vercel"]); // the vercel CLI, not wrangler ("deploy")
    expect(r.url).toBe("https://june-cake.vercel.app");
    expect(r.migrated).toEqual([]); // no D1 on Vercel
  });

  test("--prod adds the production flag", async () => {
    await stubOutput();
    let captured: string[] = [];
    const r = await juneDeploy(VERCEL_APP, {
      skipBuild: true,
      prod: true,
      runCli: async (args) => {
        captured = args;
        return { stdout: "https://june-cake.vercel.app", stderr: "", exitCode: 0 };
      },
    });
    expect(captured).toContain("--prebuilt");
    expect(captured).toContain("--prod");
    expect(r.url).toBe("https://june-cake.vercel.app");
  });

  test("--dry-run does NOT invoke the vercel CLI", async () => {
    await stubOutput();
    const h = harness();
    const r = await juneDeploy(VERCEL_APP, { skipBuild: true, dryRun: true, runCli: h.runCli });
    expect(h.events).toEqual([]); // CLI never called
    expect(r.dryRun).toBe(true);
    expect(r.url).toBeNull();
  });

  test("missing Build Output fails with a clear error", async () => {
    const h = harness();
    await expect(juneDeploy(VERCEL_APP, { skipBuild: true, runCli: h.runCli })).rejects.toThrow(
      /no Vercel Build Output/,
    );
  });
});

describe("juneDeploy → deno target", () => {
  // deno-app's config uses the deno() adapter → deploy dispatches to `deno deploy`.
  // The CLI is injected, so this drives the dispatch with no real deploy / network.
  afterEach(async () => {
    await rm(join(DENO_APP, "dist"), { recursive: true, force: true });
  });
  const stubBundle = async () => {
    await mkdir(join(DENO_APP, "dist"), { recursive: true });
    await writeFile(join(DENO_APP, "dist", "worker.js"), "export default { fetch: () => new Response('ok') };");
  };

  test("ships dist via `deno deploy` (EA) — never deployctl/vercel/wrangler, never D1", async () => {
    await stubBundle();
    let captured: string[] = [];
    const r = await juneDeploy(DENO_APP, {
      skipBuild: true,
      prod: true,
      runCli: async (args) => {
        captured = args;
        // EA serves on *.deno.net (Classic used *.deno.dev)
        return { stdout: "Production url:\n  https://june-deno.junejs.deno.net", stderr: "", exitCode: 0 };
      },
    });
    expect(captured.slice(0, 2)).toEqual(["deno", "deploy"]); // the EA CLI, not deployctl
    expect(captured).toContain("--prod");
    expect(captured).not.toContain("deployctl"); // classic is retired
    expect(r.url).toBe("https://june-deno.junejs.deno.net");
    expect(r.migrated).toEqual([]); // no D1 on Deno
  });

  test("--dry-run does NOT invoke the CLI", async () => {
    await stubBundle();
    let called = false;
    const r = await juneDeploy(DENO_APP, {
      skipBuild: true,
      dryRun: true,
      runCli: async () => {
        called = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(called).toBe(false);
    expect(r.dryRun).toBe(true);
  });

  test("missing bundle fails with a clear error", async () => {
    await expect(
      juneDeploy(DENO_APP, { skipBuild: true, runCli: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
    ).rejects.toThrow(/no built bundle/);
  });
});

describe("juneDeploy → static target (build-only)", () => {
  // static-app's config uses the staticSite() adapter → deploy dispatches to the
  // build-only path: it verifies dist/static/ and NEVER invokes a platform CLI (a
  // static host is fed by git/CI, not a deploy command).
  afterEach(async () => {
    await rm(join(STATIC_APP, "dist"), { recursive: true, force: true });
  });

  test("verifies dist/static/ and runs no CLI, no D1", async () => {
    await mkdir(join(STATIC_APP, "dist", "static"), { recursive: true });
    await writeFile(join(STATIC_APP, "dist", "static", "index.html"), "<h1>ok</h1>");
    let called = false;
    const r = await juneDeploy(STATIC_APP, {
      skipBuild: true,
      runCli: async () => {
        called = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(called).toBe(false); // no wrangler/vercel/deno
    expect(r.url).toBeNull();
    expect(r.configPath).toBe(join(STATIC_APP, "dist", "static"));
    expect(r.migrated).toEqual([]);
  });

  test("missing static site fails with a clear error", async () => {
    await expect(juneDeploy(STATIC_APP, { skipBuild: true })).rejects.toThrow(/no static site/);
  });
});
