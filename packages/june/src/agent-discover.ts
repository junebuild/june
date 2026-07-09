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
//
// There is no central registry to keep in sync — the directory IS the manifest.
// Because tools are `defineAction`s, the SAME directory is also an MCP server and
// a `.agent` manifest (surfaces land in a later step). fs lives here in the host
// package; the pure assembly is @junejs/core/agent-config's defineAgent().

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AnyAction } from "@junejs/core/agent";
import { defineAgent, type AgentConfigFile, type AgentDefinition, type Channel, type Skill } from "@junejs/core/agent-config";

async function scan(dir: string, ext: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && extname(e.name) === ext)
    .map((e) => join(dir, e.name))
    .sort();
}

// Optional YAML-ish frontmatter: --- \n key: value \n --- \n body. Falls back to
// the first non-empty line (minus a leading "# ") as the description.
function parseSkill(name: string, text: string): Skill {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const front = text.slice(3, end);
      const body = text.slice(end + 4).replace(/^\s*\n/, "");
      const meta: Record<string, string> = {};
      for (const line of front.split("\n")) {
        const m = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
        if (m) meta[m[1]!] = m[2]!;
      }
      return { name: meta.name ?? name, description: meta.description ?? "", body };
    }
  }
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  return { name, description: firstLine.replace(/^#\s*/, ""), body: text };
}

// Discover an agent from its directory, returning the assembled AgentDefinition
// (tools already adapted from defineActions; read_skill added if any skills
// exist). Mount it on a runtime with createNativeRuntime({ [agent.name]: { model,
// tools: agent.tools } }).
export async function discoverAgent(dir: string): Promise<AgentDefinition> {
  const configFile = join(dir, "agent.ts");
  const config: AgentConfigFile = existsSync(configFile)
    ? ((await import(pathToFileURL(configFile).href)).default as AgentConfigFile)
    : { name: basename(dir) };

  const instructionsFile = join(dir, "instructions.md");
  const instructions = existsSync(instructionsFile)
    ? await readFile(instructionsFile, "utf8")
    : (config.instructions ?? "");

  const tools: AnyAction[] = [];
  for (const f of await scan(join(dir, "tools"), ".ts")) {
    const mod = await import(pathToFileURL(f).href);
    if (mod.default) tools.push(mod.default as AnyAction);
  }

  const skills: Skill[] = [];
  for (const f of await scan(join(dir, "skills"), ".md")) {
    skills.push(parseSkill(basename(f, ".md"), await readFile(f, "utf8")));
  }

  const channels: Channel[] = [];
  for (const f of await scan(join(dir, "channels"), ".ts")) {
    const mod = await import(pathToFileURL(f).href);
    if (mod.default) channels.push(mod.default as Channel);
  }

  return defineAgent({
    name: config.name,
    model: config.model,
    description: config.description,
    instructions,
    tools,
    skills,
    channels,
  });
}
