#!/usr/bin/env node
// The `june` bin launcher. It runs on Node ON PURPOSE: the CLI itself
// (src/june.ts) runs on Bun, and without this hop an npm user without Bun
// gets a bare shebang error ("env: bun: No such file or directory") instead
// of a sentence telling them what to install.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "src/june.ts");
const args = process.argv.slice(2);

const probe = spawnSync("bun", ["--version"], { stdio: "ignore", shell: false });
if (probe.error || probe.status !== 0) {
  console.error(
    "june: the June CLI runs on Bun, which wasn't found on your PATH.\n" +
      "  install it:  curl -fsSL https://bun.sh/install | bash\n" +
      "  (or: brew install oven-sh/bun/bun · https://bun.sh)",
  );
  process.exit(1);
}

const child = spawnSync("bun", [entry, ...args], { stdio: "inherit", shell: false });
process.exit(child.status ?? 1);
