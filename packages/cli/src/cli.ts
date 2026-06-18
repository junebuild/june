// The `june` CLI logic — host code (node:* allowed), a thin layer over
// @junejs/server. Exposed as run(argv) so it is testable without spawning a
// process; the bin (june.ts) just forwards process.argv. See docs/cli.md.
// (curator avatar test: trivial touch to trigger Mori as kura-curator[bot])

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type Parsed = {
  verb: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

// Minimal, dependency-free parser: `june <verb> [dir] [--flag] [--flag value]`.
export function parse(argv: string[]): Parsed {
  const [verb = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { verb, positional, flags };
}

const HELP = `june — the agent-native React framework

Usage: june <command> [dir] [options]

Commands:
  dev      Start the dev server                 --port <n> --no-watch
  build    Build a workerd-ready bundle         --out <dir>
  deploy   Build + deploy (workers/vercel)      --dry-run --prod --skip-migrate --allow-destructive
  gen      Freeze content/schema                --check
  db       Database tasks (db migrate, db types) --allow-destructive
  info     Show routes + the agent surface
  help     Show this help

The app directory defaults to the current directory.
`;

function appRoot(positional: string[]): string {
  return positional[0] ? resolve(positional[0]) : process.cwd();
}

async function info(root: string): Promise<number> {
  const { createApp, loadJuneConfig } = await import("@junejs/server");
  const { resolveAgent } = await import("@junejs/core/config");
  const { ACTION_REGISTRY } = await import("@junejs/core/agent");

  const config = await loadJuneConfig(root);
  const app = createApp({ appDir: join(root, "app"), config });
  await app.warmup(); // register defineAction side effects so tools show up
  const routes = await app.routePaths();
  const agent = resolveAgent(config.agent);
  const tools = [...ACTION_REGISTRY.values()].filter((a) => a.description).map((a) => a.id);

  console.log(`June app: ${config.site?.name ?? "(unnamed)"}`);
  console.log(`\nRoutes (${routes.length}):`);
  for (const r of routes) console.log(`  ${r}`);
  if (agent.enabled) {
    console.log(`\nAgent surface:`);
    if (agent.discovery) console.log(`  discovery  /llms.txt · /sitemap.xml · /.well-known/api-catalog`);
    if (agent.mcp) console.log(`  mcp        /mcp  (tools: ${tools.length ? tools.join(", ") : "none"})`);
  } else {
    console.log(`\nAgent surface: disabled`);
  }
  return 0;
}

// Returns an exit code for one-shot commands, or undefined for long-running
// ones (dev) so the bin does NOT call process.exit and the server stays alive.
export async function run(argv: string[]): Promise<number | undefined> {
  const { verb, positional, flags } = parse(argv);
  const root = appRoot(positional);

  switch (verb) {
    case "dev": {
      // Validate BEFORE the supervisor: watching a directory that doesn't
      // exist throws a raw ENOENT, and the classic mistake `npm run dev -p
      // 3001` hands us "3001" as the app dir (npm eats the flag).
      if (!existsSync(join(root, "app"))) {
        console.error(`june dev: ${root} doesn't look like a June app (no app/ directory).`);
        if (/^\d+$/.test(positional[0] ?? "")) {
          console.error(
            `  to choose a port, use --port:  june dev --port ${positional[0]}` +
              `  ·  npm run dev -- --port ${positional[0]}`,
          );
        }
        return 1;
      }
      // A restart is the reload: the watch supervisor respawns the serving
      // child on file change (see watch.ts). Children carry JUNE_DEV_CHILD.
      if (!process.env.JUNE_DEV_CHILD && !flags["no-watch"]) {
        const { superviseDev } = await import("./watch");
        return superviseDev(root);
      }
      const { startDevServer } = await import("@junejs/server");
      await startDevServer({
        appDir: join(root, "app"),
        port: flags.port ? Number(flags.port) : 3000,
      });
      return undefined; // server keeps the process alive
    }
    case "build": {
      const { juneBuild } = await import("@junejs/server");
      const out = typeof flags.out === "string" ? { outDir: resolve(flags.out) } : {};
      const r = await juneBuild(root, out);
      console.log(
        `built ${r.outFile}  (${r.routes.length} routes, ${r.dynamicRoutes.length} dynamic, ${r.prerendered.length} prerendered)`,
      );
      return 0;
    }
    case "deploy": {
      const { juneDeploy } = await import("@junejs/server");
      const r = await juneDeploy(root, {
        dryRun: !!flags["dry-run"],
        skipMigrate: !!flags["skip-migrate"],
        allowDestructive: !!flags["allow-destructive"],
        prod: !!flags["prod"], // vercel: production deploy (default is a preview)
      });
      console.log(r.url ? `deployed → ${r.url}` : r.dryRun ? "dry-run ok" : "deployed");
      return 0;
    }
    case "gen": {
      const { generateContent } = await import("@junejs/server");
      const cols = await generateContent(root);
      console.log(cols.length ? `generated content: ${cols.join(", ")}` : "no content/ collections");
      const { generateMessages } = await import("./messages");
      const locales = await generateMessages(root);
      if (locales) console.log(`generated messages: ${locales.join(", ")}`);
      return 0;
    }
    case "db": {
      // `june db <migrate|types> [dir]`. The subcommand is positional[0], so the app
      // dir (if any) is positional[1] — not `root`.
      const sub = positional[0];
      const dbRoot = positional[1] ? resolve(positional[1]) : process.cwd();
      if (sub === "migrate") {
        const { loadJuneConfig, migrateApp, blockedMessage } = await import("@junejs/server");
        const config = await loadJuneConfig(dbRoot);
        if (!config.resources?.db) {
          console.error("june db migrate: no `db` resource declared in june.config.ts.");
          return 1;
        }
        const r = await migrateApp(dbRoot, config, { allowDestructive: !!flags["allow-destructive"] });
        if (r?.applied.length) console.log(`migrated: ${r.applied.join(", ")}`);
        else if (r && !r.blocked) console.log("migrations up to date");
        if (r?.blocked) {
          console.error(blockedMessage(r.blocked));
          return 1;
        }
        return 0;
      }
      if (sub === "types") {
        // Generate db/schema.d.ts from the migrated schema (Stage 3 inference).
        const { loadJuneConfig, typesApp } = await import("@junejs/server");
        const config = await loadJuneConfig(dbRoot);
        if (!config.resources?.db) {
          console.error("june db types: no `db` resource declared in june.config.ts.");
          return 1;
        }
        if (!config.dataLayer?.emitTypes) {
          console.error(
            "june db types: the configured dataLayer doesn't generate types " +
              "(declare `dataLayer: junoDataLayer()` in june.config.ts).",
          );
          return 1;
        }
        const text = await typesApp(dbRoot, config);
        if (text == null) {
          console.log("nothing to generate");
          return 0;
        }
        const out = join(dbRoot, "db", "schema.d.ts");
        await writeFile(out, text);
        console.log("wrote db/schema.d.ts");
        return 0;
      }
      console.error(`june db: unknown subcommand "${sub ?? ""}" (try: june db migrate | june db types)`);
      return 1;
    }
    case "info":
      return info(root);
    case "":
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`june: unknown command "${verb}"\n`);
      console.log(HELP);
      return 1;
  }
}
