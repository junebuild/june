// `june deploy` — ship a June app. Workers target (v1).
//
// The verb is fixed, the target is an adapter (same seam philosophy as
// JuneHost): today this orchestrates `june build` + wrangler (which owns auth,
// wasm/ttf rules, and the upload API); a future "june-cloud" target swaps the
// adapter, not the CLI. --dry-run is the CI test (build + wrangler validate,
// no upload).
import { existsSync } from "node:fs";
import { join } from "node:path";

import { juneBuild } from "./build";
import { loadJuneConfig } from "./config-loader";
import { blockedMessage } from "./migrate";
import { migrateD1, resolveD1Database } from "./d1-migrate";

export type DeployResult = {
  url: string | null;
  dryRun: boolean;
  configPath: string;
  migrated: string[]; // D1 migrations applied this deploy (empty if none / dry-run)
};

export async function juneDeploy(
  appRoot: string,
  options: {
    dryRun?: boolean;
    skipBuild?: boolean;
    skipMigrate?: boolean;
    allowDestructive?: boolean;
  } = {},
): Promise<DeployResult> {
  const cfg = await loadJuneConfig(appRoot);
  const target = cfg.deploy?.target ?? "workers";
  if (target !== "workers") throw new Error(`unknown deploy target: ${target}`);

  if (!options.skipBuild) {
    const built = await juneBuild(appRoot);
    console.log(`built ${built.outFile}`);
  }

  // The app's own wrangler config wins; otherwise the one `june build` emits next
  // to the bundle (its `main` is relative to the config file).
  const configPath =
    [join(appRoot, "wrangler.toml"), join(appRoot, "wrangler.jsonc")].find(existsSync) ??
    join(appRoot, "dist/wrangler.jsonc");
  if (!existsSync(configPath)) {
    throw new Error(`no wrangler config found (expected ${configPath}) — run june build first`);
  }

  // Apply pending migrations to the production D1 BEFORE shipping the new worker,
  // so the deployed code finds the schema it expects. Same migrate() (ledger +
  // destructive gate) as dev — a destructive migration halts the deploy until you
  // re-run with --allow-destructive. Skipped on --dry-run (never touches remote
  // state) and for apps with no declared db.
  const migrated: string[] = [];
  if (cfg.resources?.db && !options.skipMigrate && !options.dryRun) {
    const database = await resolveD1Database(appRoot, configPath);
    if (database) {
      const r = await migrateD1({
        appRoot,
        database,
        configPath,
        allowDestructive: options.allowDestructive,
      });
      if (r.blocked) throw new Error(`D1 ${database}: ${blockedMessage(r.blocked)}`);
      migrated.push(...r.applied);
      console.log(
        r.applied.length
          ? `migrated D1 ${database}: ${r.applied.join(", ")}`
          : `D1 ${database}: migrations up to date`,
      );
    }
  }

  if (!options.dryRun && !process.env.CLOUDFLARE_API_TOKEN) {
    console.log(
      "note: CLOUDFLARE_API_TOKEN not set — wrangler will fall back to its own login\n" +
        "      (run `bunx wrangler login` once, or export the token).",
    );
  }

  // Pinned: assets-mode needs wrangler ≥4.99 (reminder #7).
  const args = ["bunx", "wrangler@4.99.0", "deploy", "--config", configPath];
  if (options.dryRun) args.push("--dry-run");

  const proc = Bun.spawn(args, { cwd: appRoot, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (out.trim()) console.log(out.trimEnd());
  if (code !== 0) {
    if (/authentication|login|10000/i.test(err + out)) {
      throw new Error(
        "wrangler authentication failed — set CLOUDFLARE_API_TOKEN or run `bunx wrangler login`.\n" +
          err.trim(),
      );
    }
    throw new Error(`wrangler deploy failed (exit ${code})\n${err.trim()}`);
  }

  const url = out.match(/https:\/\/\S+\.workers\.dev\S*/)?.[0] ?? null;
  return { url, dryRun: options.dryRun ?? false, configPath, migrated };
}
