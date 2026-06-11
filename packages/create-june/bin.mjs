#!/usr/bin/env node
// create-june — scaffold a new June app. `npm create june my-app`.
// Non-interactive + CI-friendly: copy the template, replace __APP_NAME__, done.
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

  console.log(
    `\n✓ Scaffolded ${appName}\n\nNext steps:\n  cd ${target}\n  npm install\n  npm run dev      # → http://localhost:3000\n`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
