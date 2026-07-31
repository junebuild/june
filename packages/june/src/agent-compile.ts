// agent-compile.ts — compile an agent/ directory into a static module
// (_agent.gen.ts) so the SAME directory convention mounts where filesystem
// discovery cannot run: workerd has no fs, so discoverAgent (dynamic import +
// readFile) is native-only. The generated module is plain erasable TypeScript —
// static imports of tools/channels/connections, markdown inlined as string
// literals — bundleable by wrangler or Rolldown, importable under Node type
// stripping and bun test alike. No [[rules]] Text hack, no md loader plugins,
// no hand-maintained tool registry.
//
// Mirrors the content freeze (content.ts): a pure emitter (emitAgentModule)
// over a plain scan (scanAgentDir), with a thin fs wrapper
// (generateAgentModule) — the emitter is unit-testable without touching disk.
// Assembly logic is NOT duplicated here: the generated module exports the raw
// AgentModule shape, and both runtimes assemble it through
// @junejs/core/agent-config (assembleAgent natively, assembleDurable in a DO
// shell). Skill files are inlined raw and parsed at module init via core's
// parseSkill, so a parser improvement never requires regeneration.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const AGENT_MODULE_FILE = "_agent.gen.ts";

// The raw scan of an agent directory: file paths for code (imported statically
// by the emitted module), file contents for prose (inlined as literals).
export type AgentDirScan = {
  dir: string;
  // basename fallback when agent.ts is absent (mirrors discoverAgent).
  name: string;
  hasConfig: boolean;
  instructions: string | null;
  tools: string[]; // relative specifiers, e.g. "./tools/create_order.ts"
  skills: { name: string; raw: string }[];
  channels: string[]; // "./channels/slack.ts"
  channelOverlays: { source: string; raw: string }[]; // channels/<source>.md
  connections: string[]; // "./connections/teachify.ts"
};

// `_`-prefixed files are private by convention — most importantly the generated
// module itself, which must never be scanned back in. Sorted for determinism.
function list(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext) && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
}

// Scan an agent directory (fs only — no dynamic imports; the point is to defer
// module loading to the bundler). Returns null when the directory holds nothing
// agent-shaped, so callers can probe candidate paths cheaply.
export function scanAgentDir(dir: string): AgentDirScan | null {
  if (!existsSync(dir)) return null;
  const instructionsFile = join(dir, "instructions.md");
  const scan: AgentDirScan = {
    dir,
    name: basename(dir),
    hasConfig: existsSync(join(dir, "agent.ts")),
    instructions: existsSync(instructionsFile) ? readFileSync(instructionsFile, "utf8") : null,
    tools: list(join(dir, "tools"), ".ts").map((f) => `./tools/${f}`),
    skills: list(join(dir, "skills"), ".md").map((f) => ({
      name: basename(f, ".md"),
      raw: readFileSync(join(dir, "skills", f), "utf8"),
    })),
    channels: list(join(dir, "channels"), ".ts").map((f) => `./channels/${f}`),
    channelOverlays: list(join(dir, "channels"), ".md").map((f) => ({
      source: basename(f, ".md"),
      raw: readFileSync(join(dir, "channels", f), "utf8"),
    })),
    connections: list(join(dir, "connections"), ".ts").map((f) => `./connections/${f}`),
  };
  const empty =
    !scan.hasConfig &&
    scan.instructions === null &&
    !scan.tools.length &&
    !scan.skills.length &&
    !scan.channels.length &&
    !scan.channelOverlays.length &&
    !scan.connections.length;
  return empty ? null : scan;
}

// A stable, readable import identifier from a file specifier: "./tools/create_order.ts"
// → "tool_create_order". Collisions (foo-bar vs foo_bar) get a numeric suffix.
function identFor(prefix: string, spec: string, taken: Set<string>): string {
  const stem = basename(spec).replace(/\.ts$/, "").replace(/[^A-Za-z0-9]/g, "_");
  let id = `${prefix}_${stem}`;
  for (let i = 2; taken.has(id); i++) id = `${prefix}_${stem}_${i}`;
  taken.add(id);
  return id;
}

export type EmitOptions = {
  // Keep ".ts" on relative import specifiers. Required by consumers that run
  // the module under Node's native type stripping (Node never resolves
  // extensionless imports); rejected (TS5097) by tsconfigs without
  // allowImportingTsExtensions. generateAgentModule sniffs the consumer's
  // tsconfig; pass explicitly to override.
  tsExtensions?: boolean;
};

// Emit the module source for a scan. Pure — the golden test pins this output.
export function emitAgentModule(scan: AgentDirScan, opts?: EmitOptions): string {
  const spec = (s: string) => JSON.stringify(opts?.tsExtensions ? s : s.replace(/\.ts$/, ""));
  const taken = new Set<string>();
  const imports: string[] = [];
  const toolIds = scan.tools.map((s) => {
    const id = identFor("tool", s, taken);
    imports.push(`import ${id} from ${spec(s)};`);
    return id;
  });
  const channelIds = scan.channels.map((s) => {
    const id = identFor("channel", s, taken);
    imports.push(`import ${id} from ${spec(s)};`);
    return { key: basename(s, ".ts"), id };
  });
  const connectionIds = scan.connections.map((s) => {
    const id = identFor("connection", s, taken);
    imports.push(`import ${id} from ${spec(s)};`);
    return id;
  });
  if (scan.hasConfig) imports.push(`import config from ${spec("./agent.ts")};`);

  const lines: string[] = [
    "// AUTO-GENERATED by June — do not edit. Compiled from this agent/ directory so",
    "// the definition mounts without filesystem discovery (workerd has no fs).",
    "// Regenerate with `june gen` after adding, removing, or editing agent files.",
    ...imports,
    scan.skills.length
      ? `import { parseSkill, type AgentModule } from "@junejs/core/agent-config";`
      : `import type { AgentModule } from "@junejs/core/agent-config";`,
    "",
  ];
  if (!scan.hasConfig) lines.push(`const config = { name: ${JSON.stringify(scan.name)} };`, "");

  lines.push(
    "export const agentModule: AgentModule = {",
    "  config,",
    `  instructions: ${JSON.stringify(scan.instructions ?? "")},`,
    `  tools: [${toolIds.join(", ")}],`,
    scan.skills.length
      ? `  skills: [\n${scan.skills.map((s) => `    parseSkill(${JSON.stringify(s.name)}, ${JSON.stringify(s.raw)}),`).join("\n")}\n  ],`
      : "  skills: [],",
    channelIds.length
      ? `  channels: { ${channelIds.map((c) => `${JSON.stringify(c.key)}: ${c.id}`).join(", ")} },`
      : "  channels: {},",
    scan.channelOverlays.length
      ? `  channelInstructions: {\n${scan.channelOverlays.map((o) => `    ${JSON.stringify(o.source)}: ${JSON.stringify(o.raw)},`).join("\n")}\n  },`
      : "  channelInstructions: {},",
    `  connections: [${connectionIds.join(", ")}],`,
    "};",
    "export default agentModule;",
    "",
  );
  return lines.join("\n");
}

// Locate the agent directory for a project root: a June app keeps it at
// app/<dir> (the app.ts convention); a wrangler-first worker keeps it at
// <root>/<dir>. `dirName` follows june.config's agent.runtime.dir (default
// "agent").
export function findAgentDir(root: string, dirName = "agent"): string | null {
  for (const candidate of [join(root, "app", dirName), join(root, dirName)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Whether the consumer's tsconfig keeps ".ts" on import specifiers: the nearest
// tsconfig.json walking up from the agent dir, matched textually (tsconfig is
// JSONC; a full parse buys nothing here). Explicit opts.tsExtensions overrides.
function sniffTsExtensions(dir: string): boolean {
  for (let d = dir; ; ) {
    const candidate = join(d, "tsconfig.json");
    if (existsSync(candidate)) {
      return /"allowImportingTsExtensions"\s*:\s*true/.test(readFileSync(candidate, "utf8"));
    }
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

// Generate <dir>/_agent.gen.ts. With `check: true` nothing is written — `stale`
// reports whether the file on disk differs from what would be generated (the CI
// gate; `june gen && git diff --exit-code` works too). Returns null when the
// directory holds nothing agent-shaped.
export function generateAgentModule(
  dir: string,
  opts?: { check?: boolean } & EmitOptions,
): { file: string; code: string; stale: boolean; written: boolean } | null {
  const scan = scanAgentDir(dir);
  if (!scan) return null;
  const code = emitAgentModule(scan, { tsExtensions: opts?.tsExtensions ?? sniffTsExtensions(dir) });
  const file = join(dir, AGENT_MODULE_FILE);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  const stale = existing !== code;
  if (opts?.check) return { file, code, stale, written: false };
  if (stale) writeFileSync(file, code);
  return { file, code, stale, written: stale };
}
