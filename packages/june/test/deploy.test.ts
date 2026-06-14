// juneDeploy orchestration — the NEW migrate-before-deploy wiring and its gates.
// Both side effects (the D1 transport and the wrangler-deploy spawn) are injected,
// so this drives the real control flow with no wrangler and no network. The risky
// invariants: --dry-run never touches remote D1, and a destructive migration
// halts BEFORE the worker ships.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { juneDeploy } from "../src/deploy";
import type { D1Exec } from "../src/d1-migrate";

const DB_APP = fileURLToPath(new URL("./fixtures/deploy-db", import.meta.url));
const NODB_APP = fileURLToPath(new URL("./fixtures/deploy-nodb", import.meta.url));

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
  const runWrangler = async (args: string[]) => {
    events.push(`deploy${args.includes("--dry-run") ? ":dry" : ""}`);
    return { stdout: "Deployed\nhttps://deploytest.workers.dev", stderr: "", exitCode: 0 };
  };
  return { events, ledger, d1Exec, runWrangler };
}

describe("juneDeploy orchestration", () => {
  test("db app: migrates D1 BEFORE deploying, reports applied migrations", async () => {
    const h = harness();
    const r = await juneDeploy(DB_APP, {
      skipBuild: true,
      allowDestructive: true, // so the destructive 0002 doesn't halt this happy path
      d1Exec: h.d1Exec,
      runWrangler: h.runWrangler,
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
      runWrangler: h.runWrangler,
    });
    expect(r.migrated).toEqual([]);
    expect(h.events).toEqual(["deploy:dry"]); // no migrate:* events at all
  });

  test("destructive migration HALTS before deploy (no consent)", async () => {
    const h = harness();
    await expect(
      juneDeploy(DB_APP, { skipBuild: true, d1Exec: h.d1Exec, runWrangler: h.runWrangler }),
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
      runWrangler: h.runWrangler,
    });
    expect(r.migrated).toEqual([]);
    expect(h.events).toEqual(["deploy"]);
  });

  test("app with no db resource: skips migration entirely", async () => {
    const h = harness();
    const r = await juneDeploy(NODB_APP, {
      skipBuild: true,
      d1Exec: h.d1Exec,
      runWrangler: h.runWrangler,
    });
    expect(r.migrated).toEqual([]);
    expect(h.events).toEqual(["deploy"]); // migrate never invoked
  });
});
