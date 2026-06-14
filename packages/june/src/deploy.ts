// `june deploy` — ship a June app. The verb is fixed; the TARGET is the adapter
// (same seam philosophy as JuneHost). `june build` already produced the target's
// artifacts (workers → worker.js + wrangler.jsonc; vercel → .vercel/output/), so
// deploy just runs the platform CLI: wrangler for Workers (+ D1 migration first),
// or `vercel deploy --prebuilt` for Vercel. --dry-run validates without uploading.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { juneBuild } from "./build";
import { loadJuneConfig } from "./config-loader";
import { blockedMessage } from "./migrate";
import { migrateD1, resolveD1Database, type D1Exec } from "./d1-migrate";

// One platform-CLI invocation, factored out so tests can drive juneDeploy's
// orchestration (target dispatch, migrate-before-deploy ordering, the
// dry-run/destructive gates) without spawning wrangler or vercel.
type CliRun = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const spawnCli: CliRun = async (args, cwd) => {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

export type DeployResult = {
  url: string | null;
  dryRun: boolean;
  configPath: string; // wrangler config (workers) or the Build Output dir (vercel)
  migrated: string[]; // D1 migrations applied this deploy (empty for vercel / dry-run)
};

type DeployOptions = {
  dryRun?: boolean;
  skipBuild?: boolean;
  skipMigrate?: boolean;
  allowDestructive?: boolean;
  prod?: boolean; // vercel: deploy to production (default: a preview deploy)
  d1Exec?: D1Exec; // test seam: the D1 transport
  runCli?: CliRun; // test seam: the platform CLI invocation
};

export async function juneDeploy(appRoot: string, options: DeployOptions = {}): Promise<DeployResult> {
  const cfg = await loadJuneConfig(appRoot);
  // The adapter is the source of truth for the target; deploy.target is a legacy
  // fallback. workers() is the default when neither names one.
  const adapterName = (cfg.deploy?.adapter as { name?: string } | undefined)?.name;
  const target = adapterName ?? cfg.deploy?.target ?? "workers";
  if (target !== "workers" && target !== "vercel") {
    throw new Error(`unknown deploy target: ${target}`);
  }

  if (!options.skipBuild) {
    const built = await juneBuild(appRoot);
    console.log(`built ${built.outFile}`);
  }

  const run = options.runCli ?? spawnCli;
  return target === "vercel"
    ? deployVercel(appRoot, options, run)
    : deployWorkers(appRoot, cfg, options, run);
}

// --- Vercel: upload the prebuilt Build Output (.vercel/output/) ---------------
async function deployVercel(appRoot: string, options: DeployOptions, run: CliRun): Promise<DeployResult> {
  const out = join(appRoot, ".vercel", "output");
  if (!existsSync(join(out, "config.json"))) {
    throw new Error(`no Vercel Build Output found (expected ${out}/config.json) — run june build first`);
  }
  if (options.dryRun) {
    console.log(`dry-run: built ${out} (skipping vercel deploy)`);
    return { url: null, dryRun: true, configPath: out, migrated: [] };
  }
  if (!process.env.VERCEL_TOKEN) {
    console.log(
      "note: VERCEL_TOKEN not set — the vercel CLI will use its own login\n" +
        "      (run `bunx vercel login` once, or export the token).",
    );
  }
  // --prebuilt uploads .vercel/output as-is (no second build); --yes is
  // non-interactive; --prod targets production (default is a preview deploy).
  const args = ["bunx", "vercel@latest", "deploy", "--prebuilt", "--yes"];
  if (options.prod) args.push("--prod");

  const { stdout, stderr, exitCode } = await run(args, appRoot);
  if (stdout.trim()) console.log(stdout.trimEnd());
  if (exitCode !== 0) {
    if (/credentials|token|forbidden|unauthorized/i.test(stderr + stdout)) {
      throw new Error(
        "vercel authentication failed — set VERCEL_TOKEN or run `bunx vercel login`.\n" + stderr.trim(),
      );
    }
    throw new Error(`vercel deploy failed (exit ${exitCode})\n${stderr.trim()}`);
  }
  const url = stdout.match(/https:\/\/\S+\.vercel\.app\S*/)?.[0] ?? null;
  return { url, dryRun: false, configPath: out, migrated: [] };
}

// --- Workers: D1 migration (if any), then wrangler deploy --------------------
async function deployWorkers(
  appRoot: string,
  cfg: Awaited<ReturnType<typeof loadJuneConfig>>,
  options: DeployOptions,
  run: CliRun,
): Promise<DeployResult> {
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
        exec: options.d1Exec,
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

  const { stdout: out, stderr: err, exitCode: code } = await run(args, appRoot);
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
