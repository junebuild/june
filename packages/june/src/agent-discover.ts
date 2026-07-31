// agent-discover.ts — filesystem-first agent discovery (the eve / Next.js move).
//
// An agent is a DIRECTORY, not a config object. Location determines function:
//
//   agent/
//     agent.ts         → default-exports a plain config { name, model?, description? }
//     instructions.md  → system prompt
//     tools/*.ts       → each default-exports a defineAction (a tool)
//     skills/*.md      → each a procedure, loaded on demand (progressive disclosure)
//     channels/*.ts    → each default-exports a Channel (an inbound edge)
//     channels/*.md    → source-keyed system overlay for the same-named channel
//     connections/*.ts → each default-exports a Connection (an outbound tool source)
//
// There is no central registry to keep in sync — the directory IS the manifest.
// Because tools are `defineAction`s, the SAME directory is also an MCP server and
// a `.agent` manifest (surfaces land in a later step). fs lives here in the host
// package; the pure assembly is @junejs/core/agent-config's assembleAgent() — the
// SAME entry point a compiled agent module (agent-compile.ts, the edge path) goes
// through, so native discovery and the generated module cannot drift.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AnyAction } from "@junejs/core/agent";
import { assembleAgent, parseSkill, type AgentConfigFile, type AgentDefinition, type AgentModule, type Channel, type ChannelFactory, type Skill } from "@junejs/core/agent-config";
import type { Connection } from "@junejs/core/connections";

// `_`-prefixed files are private by convention (mirrors the app/ router) — most
// importantly the generated `_agent.gen.ts` itself, which must never be scanned
// back in as a tool/channel.
async function scan(dir: string, ext: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && extname(e.name) === ext && !e.name.startsWith("_"))
    .map((e) => join(dir, e.name))
    .sort();
}

// Read an agent directory into its raw, unassembled shape (fs + dynamic import —
// native only). The pure sibling for the edge is agent-compile.ts, which emits
// the same AgentModule as static code.
export async function discoverAgentModule(dir: string): Promise<AgentModule> {
  const configFile = join(dir, "agent.ts");
  const config: AgentConfigFile = existsSync(configFile)
    ? ((await import(pathToFileURL(configFile).href)).default as AgentConfigFile)
    : { name: basename(dir) };

  const instructionsFile = join(dir, "instructions.md");
  const instructions = existsSync(instructionsFile) ? await readFile(instructionsFile, "utf8") : "";

  const tools: AnyAction[] = [];
  for (const f of await scan(join(dir, "tools"), ".ts")) {
    const mod = await import(pathToFileURL(f).href);
    if (mod.default) tools.push(mod.default as AnyAction);
  }

  const skills: Skill[] = [];
  for (const f of await scan(join(dir, "skills"), ".md")) {
    skills.push(parseSkill(basename(f, ".md"), await readFile(f, "utf8")));
  }

  // A channel module default-exports a Channel OR a `(env) => Channel` factory (the
  // form workerd needs — secrets live in env, not at module scope). Resolution is
  // assembleAgent's job (native: process.env; a DO: its own env) — keep raw here.
  const channels: Record<string, Channel | ChannelFactory> = {};
  for (const f of await scan(join(dir, "channels"), ".ts")) {
    const mod = await import(pathToFileURL(f).href);
    if (mod.default) channels[basename(f, ".ts")] = mod.default as Channel | ChannelFactory;
  }

  // channels/<source>.md — a system overlay applied when a turn's inbound event
  // source matches the file's basename (see AgentDefinition.channelInstructions).
  const channelInstructions: Record<string, string> = {};
  for (const f of await scan(join(dir, "channels"), ".md")) {
    channelInstructions[basename(f, ".md")] = await readFile(f, "utf8");
  }

  // connections/*.ts — outbound: definitions of external MCP/OpenAPI servers;
  // assembleAgent wires them (connectAll) where the agent actually runs.
  const connections: Connection[] = [];
  for (const f of await scan(join(dir, "connections"), ".ts")) {
    const mod = await import(pathToFileURL(f).href);
    if (mod.default) connections.push(mod.default as Connection);
  }

  return { config, instructions, tools, skills, channels, channelInstructions, connections };
}

// Discover an agent from its directory, returning the assembled AgentDefinition
// (tools already adapted from defineActions; read_skill added if any skills
// exist). Mount it on a runtime with createNativeRuntime({ [agent.name]: { model,
// tools: agent.tools } }).
export async function discoverAgent(dir: string): Promise<AgentDefinition> {
  return assembleAgent(await discoverAgentModule(dir), process.env);
}
