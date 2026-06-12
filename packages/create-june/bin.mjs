#!/usr/bin/env node
// create-june — scaffold a new June app. `npm create june my-app`.
// Non-interactive + CI-friendly: copy the template, replace __APP_NAME__, done.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "template");

async function copyTemplate(src, dest, appName) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    // npm strips .gitignore from published packages, so the template ships it as
    // _gitignore; restore the real name on the way out.
    const outName = entry.name === "_gitignore" ? ".gitignore" : entry.name;
    const s = join(src, entry.name);
    const d = join(dest, outName);
    if (entry.isDirectory()) {
      await copyTemplate(s, d, appName);
    } else {
      const content = (await readFile(s, "utf8")).replaceAll("__APP_NAME__", appName);
      await writeFile(d, content);
    }
  }
}

// Which package manager invoked us — npm/bun/pnpm/yarn set this, so the
// next-steps we print match the tool the user already chose.
function packageManager() {
  const ua = process.env.npm_config_user_agent ?? "";
  const name = ua.split("/")[0];
  return ["npm", "bun", "pnpm", "yarn"].includes(name) ? name : "npm";
}

function hasBun() {
  return spawnSync("bun", ["--version"], { stdio: "ignore", shell: false }).status === 0;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: create-june <dir>");
    process.exit(1);
  }
  const dest = resolve(target);
  const appName = basename(dest).replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
  if (existsSync(dest) && (await readdir(dest)).length > 0) {
    console.error(`create-june: ${dest} already exists and is not empty`);
    process.exit(1);
  }

  await copyTemplate(TEMPLATE, dest, appName);

  const pm = packageManager();
  const run = pm === "npm" ? "npm run dev" : `${pm} dev`;
  const adhoc = pm === "bun" ? "bunx june info" : "npx june info";
  console.log(
    `\n✓ Scaffolded ${appName}\n\nNext steps:\n  cd ${target}\n  ${pm} install\n  ${run}      # → http://localhost:3000\n\nThe CLI is local to the project (no global install): ${adhoc}\n`,
  );
  if (!hasBun()) {
    console.log(
      `note: the june CLI runs on Bun, which wasn't found on your PATH.\n` +
        `  install it first:  curl -fsSL https://bun.sh/install | bash\n` +
        `  (or: brew install oven-sh/bun/bun · https://bun.sh)\n`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
