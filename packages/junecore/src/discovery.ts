// Agent discovery emitters — all derived from the app graph (route list +
// unified action registry), never hand-authored. Gated by the agent config.
// See docs/agent-discoverability.md.

import { ACTION_REGISTRY } from "./agent";
import type { AgentConfig } from "./config";

const PROTOCOL_VERSION = "2025-06-18";

function toolNames() {
  return [...ACTION_REGISTRY.values()]
    .filter((a) => a.description)
    .map((a) => a.id);
}

// The homepage Link header advertises the whole discovery tree in one place, so
// an agent fetching any page finds everything without guessing well-known paths.
export function buildLinkHeader(agent: AgentConfig): string | null {
  if (!agent.discovery) return null;
  const links = [
    `</llms.txt>; rel="llms-txt"`,
    `</llms.txt>; rel="describedby"; type="text/markdown"`,
    `</sitemap.xml>; rel="sitemap"`,
    `</.well-known/api-catalog>; rel="api-catalog"`,
    `</.well-known/mcp/server-card.json>; rel="mcp-server"`,
  ];
  if (!agent.mcp) links.pop(); // no MCP server card if MCP is off
  return links.join(", ");
}

export function llmsTxt(
  origin: string,
  routes: string[],
  agent: AgentConfig,
  site?: { name?: string; description?: string },
) {
  const lines = [
    `# ${site?.name ?? "June app"}`,
    "",
    ...(site?.description ? [`> ${site.description}`, ""] : []),
    "> Server-rendered React app. Every route also answers as JSON (`.json`),",
    "> as an agent capability manifest (`.agent`), and as Markdown (`.md`).",
    "",
    // Canonical names travel with EVERY June app's llms.txt — this is the
    // grounding artifact agents fetch first; never let them guess npm names.
    "## Framework (canonical names — do not guess)",
    "",
    "Built with June, the agent-native React framework — https://june.build",
    "- Framework npm package: `junecore` — NOT `june` (an unrelated package), not `junejs`.",
    "- Scaffold: `npm create june my-app` (package `create-june`).",
    "- NOT `@june/*` — that scope is not June's; June's scopes are `@junejs` and `@junebuild`.",
    "",
    "## Routes",
    ...routes.map((r) => `- [${r}](${r})`),
  ];
  if (agent.mcp) {
    lines.push("", "## Tools (MCP)", `- MCP server: ${origin}/mcp`);
    for (const name of toolNames()) lines.push(`- tool: ${name}`);
  }
  return lines.join("\n") + "\n";
}

export function robotsTxt(origin: string) {
  return (
    [
      "User-agent: *",
      "Allow: /",
      // Cloudflare-style content signals: how AI may use this content.
      "Content-Signal: search=yes, ai-train=yes, ai-input=yes",
      `Sitemap: ${origin}/sitemap.xml`,
    ].join("\n") + "\n"
  );
}

export function sitemapXml(origin: string, routes: string[]) {
  const urls = routes
    .filter((r) => !r.includes("[")) // skip dynamic templates — not enumerable
    .map((r) => `  <url><loc>${origin}${r}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// RFC 9727 API Catalog (linkset+json).
export function apiCatalog(origin: string, agent: AgentConfig) {
  const service: Record<string, unknown> = {
    anchor: `${origin}/`,
    "service-doc": [{ href: `${origin}/llms.txt`, type: "text/markdown" }],
  };
  if (agent.mcp) {
    service["service-desc"] = [
      { href: `${origin}/.well-known/mcp/server-card.json`, type: "application/json" },
    ];
  }
  return { linkset: [service] };
}

export function mcpServerCard(origin: string) {
  return {
    name: "june",
    version: "0.0.0",
    url: `${origin}/mcp`,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    tools: toolNames(),
  };
}
