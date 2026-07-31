// The F7 build auto-mount: a June app with app/agent/ builds to an edge worker
// whose entry exports the Durable Object class, whose manifest carries
// agentName (what activates createWorker's chat routing — proven end-to-end by
// worker-agent-edge.test.ts), and whose wrangler.jsonc binds the DO. Zero
// hand-written worker glue. One real Rolldown build in beforeAll, assertions
// over its artifacts (the build.test.ts pattern).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ACTION_REGISTRY } from "@junejs/core/agent";
import type { AnyAction } from "@junejs/core/agent";
import { buildManifest, juneBuild } from "../src/build";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "app-agent");

// The fixture isn't a workspace member, so Rolldown can't resolve @junejs/*
// from it — link the real packages in (node_modules is gitignored; create the
// links here, idempotently) so the durable graph genuinely BUNDLES, instead of
// falling back to unresolved-as-external.
function linkJunejs(): void {
  const scope = join(FIXTURE, "node_modules", "@junejs");
  mkdirSync(scope, { recursive: true });
  const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const [name, dir] of [["core", "core"], ["server", "june"]] as const) {
    if (!existsSync(join(scope, name))) symlinkSync(join(packages, dir), join(scope, name), "dir");
  }
}

let outDir: string;
// Building imports the fixture's tools (defineAction self-registers globally); isolate.
let preexisting: Map<string, AnyAction>;

beforeAll(async () => {
  preexisting = new Map(ACTION_REGISTRY);
  linkJunejs();
  outDir = mkdtempSync(join(tmpdir(), "june-agent-build-"));
  await juneBuild(FIXTURE, { outDir });
});
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  ACTION_REGISTRY.clear();
  for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a);
});

describe("june build with app/agent/", () => {
  test("compiles the agent module during the build", () => {
    const gen = join(FIXTURE, "app", "agent", "_agent.gen.ts");
    expect(existsSync(gen)).toBe(true);
    expect(readFileSync(gen, "utf8")).toContain(`import tool_echo from "./tools/echo";`);
  });

  test("the generated entry mounts the durable agent", () => {
    const entry = readFileSync(join(FIXTURE, ".june", "worker-entry.tsx"), "utf8");
    expect(entry).toContain("agentName: __agentModule.config.name");
    expect(entry).toContain("export class JuneAgentDO extends DurableObject");
    expect(entry).toContain(`import { DurableObject } from "cloudflare:workers";`);
    expect(entry).toContain("assembleDurable(__agentModule)");
  });

  test("the bundled worker carries the DO class; cloudflare:workers stays external", () => {
    const js = readFileSync(join(outDir, "worker.js"), "utf8");
    expect(js).toContain("JuneAgentDO");
    expect(js).toContain("cloudflare:workers");
  });

  test("wrangler.jsonc binds the DO namespace + the SQLite-class migration", () => {
    const cfg = JSON.parse(readFileSync(join(outDir, "wrangler.jsonc"), "utf8")) as {
      durable_objects?: unknown;
      migrations?: unknown;
    };
    expect(cfg.durable_objects).toEqual({ bindings: [{ name: "AGENT", class_name: "JuneAgentDO" }] });
    expect(cfg.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["JuneAgentDO"] }]);
  });

  test("buildManifest sets agentName (inert without an env.AGENT binding)", async () => {
    const manifest = await buildManifest(FIXTURE);
    expect(manifest.agentName).toBe("ops");
  });
});
