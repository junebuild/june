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

// One resolved /llms.txt link — what the host hands llmsTxt after reading each
// route's `llms` declaration (see LlmsEntry in ./route). `url` is absolute and
// already points at the page's markdown projection where there is one.
export type LlmsLink = { title: string; url: string; description?: string; section: string; optional: boolean };

// Render links as llmstxt.org file lists: one H2 per section in first-seen order,
// each link "- [title](url): description". The Optional links come back SEPARATELY,
// so the caller can place them last — the split is structural, never found by
// searching rendered text. "Optional" is llmstxt.org's reserved name for skippable
// links, so a link filed under a section literally named "Optional" is optional too.
const OPTIONAL = "Optional";
function linkSections(links: LlmsLink[]): { regular: string[]; optional: string[] } {
  const item = (l: LlmsLink) =>
    `- [${l.title.replace(/[[\]]/g, "\\$&")}](${l.url})${l.description ? `: ${l.description}` : ""}`;
  const isOptional = (l: LlmsLink) => l.optional || l.section === OPTIONAL;
  const bySection = new Map<string, LlmsLink[]>();
  for (const l of links.filter((x) => !isOptional(x))) {
    if (!bySection.has(l.section)) bySection.set(l.section, []);
    bySection.get(l.section)!.push(l);
  }
  const regular: string[] = [];
  for (const [section, ls] of bySection) regular.push("", `## ${section}`, ...ls.map(item));
  const opt = links.filter(isOptional);
  return { regular, optional: opt.length ? ["", `## ${OPTIONAL}`, ...opt.map(item)] : [] };
}

export function llmsTxt(
  origin: string,
  routes: string[],
  agent: AgentConfig,
  site?: { name?: string; description?: string },
  // The routes' resolved llms.txt links (the host collects them). Absent → the
  // legacy flat "## Routes" list of static paths, for callers that pass only paths.
  links?: LlmsLink[],
) {
  // Canonical names travel with EVERY June app's llms.txt — the grounding artifact agents fetch
  // first; never let them guess npm names. An app built ON June (e.g. Kura) can override this
  // block via agent.llms.framework to point at its own scaffold/scope.
  const framework = agent.llms?.framework ?? [
    "## Framework (canonical names — do not guess)",
    "",
    "Built with June, the agent-native React framework — https://june.build",
    "- Framework npm package: `@junejs/core` — NOT `june` (an unrelated package), not `junejs`.",
    "- Scaffold: `npm create june my-app` (package `create-june`).",
    "- NOT `@june/*` — that scope is not June's; June's scopes are `@junejs` and `@junebuild`.",
  ];
  // Drop dynamic route templates (e.g. /docs/[[...slug]]) — an agent can't fetch a pattern.
  // (Same filter as the sitemap.) Apps list real pages via agent.llms.sections.
  const staticRoutes = routes.filter((r) => !r.includes("["));
  const lines = [
    `# ${site?.name ?? "June app"}`,
    "",
    ...(site?.description ? [`> ${site.description}`, ""] : []),
    "> Server-rendered React app. Every route also answers as Markdown",
    "> (`.md`) and JSON (`.json`); actions are MCP tools at `/mcp`.",
    "",
    // App-authored "when to reach for this site" guidance sits right under the
    // summary: the first thing an agent choosing between tools should read.
    ...(agent.llms?.whenToUse?.length
      ? ["## When to use", "", ...agent.llms.whenToUse.map((w) => `- ${w}`), ""]
      : []),
    ...framework,
  ];
  // "## Optional" is the part an agent may drop when context is short, so it is the
  // LAST H2 of the file — after the tools, which an agent should never lose.
  let optional: string[] = [];
  if (links) {
    const sections = linkSections(links);
    optional = sections.optional;
    // app-authored agent.llms.sections sit with the regular sections
    lines.push(...sections.regular, ...(agent.llms?.sections?.length ? ["", ...agent.llms.sections] : []));
  } else {
    lines.push(
      "",
      "## Routes",
      ...staticRoutes.map((r) => `- [${r}](${r})`),
      ...(agent.llms?.sections?.length ? ["", ...agent.llms.sections] : []),
    );
  }
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
  lines.push(...optional);
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

// One sitemap page: its pathname and, when the app knows it, when its content
// last changed. A bare string is a page with no known date.
export type SitemapPage = { path: string; lastModified?: string | Date };

// <lastmod> wants a W3C datetime. A Date at UTC midnight (a YAML `date: 2026-06-12`
// frontmatter value) prints as the plain date; any other Date as a full ISO
// timestamp. A string passes only if it already looks like a W3C date — an
// unparseable value is dropped, never emitted as a broken tag.
function w3cDate(v: string | Date | undefined): string | undefined {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return undefined;
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  // W3C datetime: hh 00–23, mm/ss 00–59, TZD Z or ±hh:mm. The ranges live in the
  // pattern because Date.parse accepts ISO's "24:00" (next midnight).
  const m =
    /^(\d{4})(?:-(\d{2})(?:-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?)?)?$/.exec(t);
  if (!m || Number.isNaN(Date.parse(t))) return undefined;
  // Date.parse rolls an impossible day over ("2026-02-30" → March 2), so the
  // calendar part must survive a round trip through a real UTC date.
  const [, y, mo = "01", d = "01"] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return day.toISOString().slice(0, 10) === `${y}-${mo}-${d}` ? t : undefined;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function sitemapXml(origin: string, routes: Array<string | SitemapPage>, i18n?: I18nConfig) {
  const pages = routes
    .map((r) => (typeof r === "string" ? { path: r } : r))
    .filter((p) => !p.path.includes("[")); // skip dynamic templates
  // With i18n, each page carries xhtml:link rel="alternate" hreflang for its
  // locale variants (the SEO content surface; llms.txt / /mcp stay canonical).
  const host = i18n ? new URL(origin).host : "";
  const protocol = i18n ? new URL(origin).protocol.replace(":", "") : "";
  const abs = (href: string) => (href.startsWith("http") ? href : `${origin}${href}`);
  const urls = pages
    .map(({ path: r, lastModified }) => {
      const loc = `<loc>${xmlEscape(origin + r)}</loc>`;
      const date = w3cDate(lastModified);
      const lastmod = date ? `<lastmod>${date}</lastmod>` : "";
      if (!i18n) return `  <url>${loc}${lastmod}</url>`;
      const links = localeAlternates(i18n, r, { currentHost: host, protocol })
        .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${xmlEscape(abs(a.href))}"/>`)
        .join("\n");
      return `  <url>\n    ${loc}${lastmod ? `\n    ${lastmod}` : ""}\n${links}\n  </url>`;
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
