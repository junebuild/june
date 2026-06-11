import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin.mjs", import.meta.url));

describe("create-june scaffolder", () => {
  test("scaffolds an app skeleton with __APP_NAME__ replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "june-create-"));
    const appDir = join(dir, "My-Cool-App");
    const proc = Bun.spawn(["bun", BIN, appDir], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);

    const pkg = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-cool-app"); // derived from dir, lowercased
    expect(pkg.scripts.dev).toBe("june dev");
    expect(pkg.devDependencies["@junejs/cli"]).toBeDefined();
    expect(pkg.dependencies["@junejs/core"]).toBeDefined();

    for (const f of [
      "june.config.ts",
      "app/page.tsx",
      "app/layout.tsx",
      "app/users/page.tsx",
      "README.md",
      ".gitignore", // restored from _gitignore
      "tsconfig.json",
    ]) {
      expect(existsSync(join(appDir, f))).toBe(true);
    }
    expect(existsSync(join(appDir, "_gitignore"))).toBe(false);

    expect(await readFile(join(appDir, "june.config.ts"), "utf8")).toContain('name: "my-cool-app"');
    expect(await readFile(join(appDir, "README.md"), "utf8")).toContain("# my-cool-app");

    await rm(dir, { recursive: true, force: true });
  });

  test("refuses to scaffold into a non-empty directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "june-create-"));
    await writeFile(join(dir, "existing.txt"), "x");
    const proc = Bun.spawn(["bun", BIN, dir], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});
