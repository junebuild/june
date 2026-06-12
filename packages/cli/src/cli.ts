// The `june` CLI logic — host code (node:* allowed), a thin layer over
// @junejs/server. Exposed as run(argv) so it is testable without spawning a
// process; the bin (june.ts) just forwards process.argv. See docs/cli.md.

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
  deploy   Build + deploy (Workers)             --dry-run
  gen      Freeze content/schema                --check
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
      const r = await juneDeploy(root, { dryRun: !!flags["dry-run"] });
      console.log(r.url ? `deployed → ${r.url}` : r.dryRun ? "dry-run ok" : "deployed");
      return 0;
    }
    case "gen": {
      const { generateContent } = await import("@junejs/server");
      const cols = await generateContent(root);
      console.log(cols.length ? `generated content: ${cols.join(", ")}` : "no content/ collections");
      return 0;
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
