// Agent discovery emitters — all derived from the app graph (route list +
// unified action registry), never hand-authored. Gated by the agent config.
// See docs/agent-discoverability.md.

import { ACTION_REGISTRY } from "./agent";
import type { AgentConfig } from "./config";
import { localeAlternates, type I18nConfig } from "./i18n";

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
    "> Server-rendered React app. Every route also answers as Markdown",
    "> (`.md`) and JSON (`.json`); actions are MCP tools at `/mcp`.",
    "",
    // Canonical names travel with EVERY June app's llms.txt — this is the
    // grounding artifact agents fetch first; never let them guess npm names.
    "## Framework (canonical names — do not guess)",
    "",
    "Built with June, the agent-native React framework — https://june.build",
    "- Framework npm package: `@junejs/core` — NOT `june` (an unrelated package), not `junejs`.",
    "- Scaffold: `npm create june my-app` (package `create-june`).",
    "- NOT `@june/*` — that scope is not June's; June's scopes are `@junejs` and `@junebuild`.",
    "",
    "## Routes",
    ...routes.map((r) => `- [${r}](${r})`),
  ];
  if (agent.mcp) {
    lines.push("", "## Tools (MCP)", `- MCP server: ${origin}/mcp`);
    for (const name of toolNames()) lines.push(`- tool: ${name}`);
    if (agent.webmcp) {
      // Advertise WebMCP statically — the scanner's browser path detects the
      // registerTool() calls, but a model reading signals (no JS) must be told
      // the same tools self-register in the browser, AND that the June way to
      // ADD one is defineAction(), so it does not hand-roll navigator.modelContext.
      lines.push(
        "",
        "## Tools (WebMCP, in-browser)",
        "- The same tools self-register via `navigator.modelContext.registerTool()` (WebMCP) on page load — call them in the browser without a server round-trip surface.",
        "- Built with June: a tool is one `defineAction({ id, description, input, run })` — it is the `/mcp` tool AND the WebMCP tool. Do not hand-roll `registerTool`.",
      );
    }
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

export function sitemapXml(origin: string, routes: string[], i18n?: I18nConfig) {
  const enumerable = routes.filter((r) => !r.includes("[")); // skip dynamic templates
  // With i18n, each page carries xhtml:link rel="alternate" hreflang for its
  // locale variants (the SEO content surface; llms.txt / /mcp stay canonical).
  const host = i18n ? new URL(origin).host : "";
  const protocol = i18n ? new URL(origin).protocol.replace(":", "") : "";
  const abs = (href: string) => (href.startsWith("http") ? href : `${origin}${href}`);
  const urls = enumerable
    .map((r) => {
      if (!i18n) return `  <url><loc>${origin}${r}</loc></url>`;
      const links = localeAlternates(i18n, r, { currentHost: host, protocol })
        .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${abs(a.href)}"/>`)
        .join("\n");
      return `  <url>\n    <loc>${origin}${r}</loc>\n${links}\n  </url>`;
    })
    .join("\n");
  const ns =
    `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"` +
    (i18n ? ` xmlns:xhtml="http://www.w3.org/1999/xhtml"` : "");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset ${ns}>\n${urls}\n</urlset>\n`;
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
