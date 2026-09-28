// Agent discovery emitters — all derived from the app graph (route list +
// unified action registry), never hand-authored. Gated by the agent config.
// See docs/agent-discoverability.md.

import { ACTION_REGISTRY } from "./agent";
import { apiActionPath, isRoutableActionId, OPENAPI_MEDIA_TYPE } from "./api";
import type { AgentConfig, SiteConfig } from "./config";
import { withBasePath, type DocumentConfig } from "./document";
import { localeAlternates, type I18nConfig } from "./i18n";
import { fitCardText, mcpServerIdentity, PROTOCOL_VERSION } from "./mcp";

function toolNames() {
  return [...ACTION_REGISTRY.values()]
    .filter((a) => a.description)
    .map((a) => a.id);
}

// The MCP Server Card's media type (experimental-ext-server-card docs/discovery.md).
// ONE constant for every place the card appears — the response, the api-catalog
// link, the Link header — so what we advertise never drifts from what we serve.
export const MCP_SERVER_CARD_TYPE = "application/mcp-server-card+json";

// The homepage Link header advertises the whole discovery tree in one place, so
// an agent fetching any page finds everything without guessing well-known paths.
// `catalogs: false` drops the ai-catalog relation — the host passes its catalog
// publication rule (e.g. a basePath site publishes no /.well-known catalog).
export function buildLinkHeader(agent: AgentConfig, opts: { catalogs?: boolean } = {}): string | null {
  if (!agent.discovery) return null;
  const links = [
    `</llms.txt>; rel="llms-txt"`,
    `</llms.txt>; rel="describedby"; type="text/markdown"`,
    `</sitemap.xml>; rel="sitemap"`,
    `</.well-known/api-catalog>; rel="api-catalog"`,
  ];
  // ai-catalog is the relation the AI Catalog spec defines for Link-header discovery.
  if (opts.catalogs !== false) links.push(`<${AI_CATALOG_PATH}>; rel="ai-catalog"; type="application/json"`);
  if (agent.mcp) links.push(`</.well-known/mcp/server-card.json>; rel="mcp-server"; type="${MCP_SERVER_CARD_TYPE}"`);
  if (agent.api) links.push(`</openapi.json>; rel="service-desc"; type="${OPENAPI_MEDIA_TYPE}"`);
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
    agent.mcp ? "> (`.md`) and JSON (`.json`); actions are MCP tools at `/mcp`." : "> (`.md`) and JSON (`.json`).",
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
  if (agent.api) {
    // The same actions as plain HTTP, for clients that speak OpenAPI / function
    // calling rather than MCP. Listed even with MCP off: it's its own surface.
    lines.push(
      "",
      "## HTTP API",
      `- OpenAPI 3.1: ${origin}/openapi.json`,
      `- Each tool is also \`POST ${origin}/api/<tool>\` with its input as the JSON body (\`{}\` when it takes none); errors are JSON \`{ "error": { "code", "message", "hint?" } }\`.`,
    );
  }
  lines.push(...optional);
  return lines.join("\n") + "\n";
}

// `catalogs: false` drops the Agentmap line, like buildLinkHeader's option.
export function robotsTxt(origin: string, opts: { catalogs?: boolean } = {}) {
  return (
    [
      "User-agent: *",
      "Allow: /",
      // Cloudflare-style content signals: how AI may use this content.
      "Content-Signal: search=yes, ai-train=yes, ai-input=yes",
      `Sitemap: ${origin}/sitemap.xml`,
      // ARD (agenticresourcediscovery.org): where the agent-resource catalog lives.
      ...(opts.catalogs === false ? [] : [`Agentmap: ${origin}${AI_CATALOG_PATH}`]),
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

// --- the agent services this app exposes -----------------------------------
// ONE list feeds every catalog (RFC 9727 api-catalog, the ARD/AI Catalog), so a
// surface added here shows up in all of them. A new surface (e.g. a REST/OpenAPI
// projection of the actions) is one more entry, gated on its own config flag.
export type AgentService = {
  // Stable short name of the surface ("site", "mcp", "api").
  id: string;
  // The service endpoint itself (the RFC 9727 `item` and linkset anchor).
  endpoint: string;
  // Its machine-readable description (RFC 9727 `service-desc`), when it has one.
  desc?: { href: string; type: string };
  // Its human/agent documentation (RFC 9727 `service-doc`).
  doc: { href: string; type: string };
  // The AI Catalog entry for it; absent → the service is listed in the
  // api-catalog only (it is an HTTP API, not an AI artifact).
  catalog?: { namespace: string; type: string; url: string; displayName: string };
};

function siteLabel(origin: string, site?: { name?: string }) {
  return site?.name ?? new URL(origin).host;
}

export function agentServices(
  origin: string,
  agent: AgentConfig,
  site?: { name?: string },
): AgentService[] {
  const llms = { href: `${origin}/llms.txt`, type: "text/markdown" };
  // The site itself is an API: every route answers as Markdown (.md) and JSON
  // (.json), indexed by llms.txt.
  const services: AgentService[] = [{ id: "site", endpoint: `${origin}/`, doc: llms }];
  if (agent.mcp) {
    const card = `${origin}/.well-known/mcp/server-card.json`;
    services.push({
      id: "mcp",
      endpoint: `${origin}/mcp`,
      desc: { href: card, type: MCP_SERVER_CARD_TYPE },
      doc: llms,
      catalog: {
        namespace: "mcp",
        type: MCP_SERVER_CARD_TYPE,
        url: card,
        displayName: `${siteLabel(origin, site)} MCP server`,
      },
    });
  }
  if (agent.api) {
    // The same actions as plain HTTP (POST /api/<id>), described by OpenAPI.
    const spec = `${origin}/openapi.json`;
    services.push({
      id: "api",
      endpoint: `${origin}/api/`,
      desc: { href: spec, type: OPENAPI_MEDIA_TYPE },
      doc: llms,
      catalog: {
        namespace: "api",
        type: OPENAPI_MEDIA_TYPE,
        url: spec,
        displayName: `${siteLabel(origin, site)} HTTP API`,
      },
    });
  }
  return services;
}

// RFC 9727 API Catalog (linkset+json). The first context is the catalog itself
// (anchor = its own well-known URI) listing each API as an `item`; each API then
// gets its own context carrying its service-desc / service-doc (RFC 9727 §4 and
// Appendix A).
export const API_CATALOG_CONTENT_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

type Link = { href: string; type?: string };
export type LinksetContext = {
  anchor: string;
  item?: Link[];
  "service-desc"?: Link[];
  "service-doc"?: Link[];
};

export function apiCatalog(origin: string, agent: AgentConfig): { linkset: LinksetContext[] } {
  const services = agentServices(origin, agent);
  const describe = (s: AgentService): LinksetContext => ({
    anchor: s.endpoint,
    ...(s.desc ? { "service-desc": [s.desc] } : {}),
    "service-doc": [s.doc],
  });
  return {
    linkset: [
      { anchor: `${origin}/.well-known/api-catalog`, item: services.map((s) => ({ href: s.endpoint })) },
      ...services.map(describe),
    ],
  };
}

// --- Agent Skills (Agent Skills Discovery RFC v0.2.0) ------------------------
// Every June app publishes one generated skill: "how to use this site" — read it
// as Markdown, call its tools over MCP. Served at
// /.well-known/agent-skills/<name>/SKILL.md and listed (with a sha256 digest of
// the exact served bytes) in /.well-known/agent-skills/index.json.
export const AGENT_SKILLS_INDEX_PATH = "/.well-known/agent-skills/index.json";
const AGENT_SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

// Agent Skills names: 1-64 chars of [a-z0-9-], no leading/trailing/double hyphen.
// Derived from the HOST, not site.name: a host is stable, unique to the site and
// always ASCII (an IDN arrives as punycode), where a site name is often a tagline
// or in a non-Latin script that has no faithful ASCII slug.
export function skillName(origin: string): string {
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || "site";
}

// JSON strings are valid YAML double-quoted scalars — safe for any description.
const yamlString = (s: string) => JSON.stringify(s);

function paramList(input: unknown): string {
  const props = (input as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties;
  if (!props) return "";
  const required = new Set((input as { required?: string[] }).required ?? []);
  return Object.entries(props)
    .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${typeof v?.type === "string" ? v.type : "any"}`)
    .join(", ");
}

export type AgentSkill = { name: string; description: string; url: string; markdown: string };

export function siteSkill(
  origin: string,
  agent: AgentConfig,
  site?: { name?: string; description?: string },
): AgentSkill {
  const name = skillName(origin);
  const host = new URL(origin).host;
  const label = siteLabel(origin, site);
  const rich = [...ACTION_REGISTRY.values()].filter((a) => a.description);
  const tools = agent.mcp || agent.api ? rich : [];
  // The HTTP surface serves only the ids a URL path can carry (see api.ts).
  const httpTools = agent.api ? rich.filter((a) => isRoutableActionId(a.id)) : [];
  const via = [agent.mcp && "MCP", agent.api && "HTTP"].filter(Boolean).join(" or ");
  const about = site?.description?.replace(/\s+/g, " ").trim().replace(/[.。]$/, "");
  const description = (
    `Use ${host}${about ? `: ${about}` : ""}. ` +
    `Read its pages as Markdown` +
    (tools.length ? ` and call its ${tools.length} tool${tools.length === 1 ? "" : "s"} over ${via}` : "") +
    `. Use when a task needs information from ${host}` +
    (tools.length ? ` or actions on it.` : ".")
  ).slice(0, 1024);

  const lines = [
    "---",
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    "---",
    "",
    `# ${label}`,
    "",
    ...(site?.description ? [`> ${site.description}`, ""] : []),
    "## Read",
    "",
    `- Start at ${origin}/llms.txt — every page, grouped and described. Its links point at each page's Markdown version where the page has one.`,
    "- Markdown: a page that offers it says so with `<link rel=\"alternate\" type=\"text/markdown\" href=\"…\">` in its head — fetch that URL, append `.md` to the page's URL, or request the page with `Accept: text/markdown`. A page whose route turned Markdown off has no such link and answers 404 there: read the HTML instead.",
    "- JSON: likewise, append `.json` for the page's data where the page offers it (404 where it doesn't).",
    `- Full page list: ${origin}/sitemap.xml`,
  ];
  if (agent.mcp) {
    lines.push(
      "",
      "## Act (MCP)",
      "",
      `- Endpoint: ${origin}/mcp — MCP over Streamable HTTP: POST JSON-RPC \`initialize\`, \`tools/list\`, \`tools/call\`.`,
      "- Each tool's full input schema comes back from `tools/list`.",
    );
    if (tools.length) {
      lines.push("", "Tools:", "");
      for (const t of tools) {
        const gate = t.requiresPrincipal ? " (requires a signed-in user)" : "";
        lines.push(`- \`${t.id}(${paramList(t.input)})\`${gate} — ${t.description.replace(/\s+/g, " ").trim()}`);
      }
      const first = tools[0]!;
      lines.push(
        "",
        "Call a tool:",
        "",
        "```sh",
        `curl -s ${origin}/mcp -H 'content-type: application/json' \\`,
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${first.id}","arguments":{}}}'`,
        "```",
        "",
        "(Fill `arguments` per the tool's input schema.)",
      );
    }
  }
  if (agent.api) {
    lines.push(
      "",
      "## Act (HTTP)",
      "",
      `- OpenAPI 3.1: ${origin}/openapi.json — one POST operation per tool, \`operationId\` = the tool name, with its input schema.`,
      `- Call: \`POST ${origin}/api/<tool>\` with \`Content-Type: application/json\` and the input as the body (\`{}\` when it takes none). The result comes back as JSON; a failure is \`{ "error": { "code", "message", "hint?" } }\`.`,
    );
    // The tool list lives under MCP when MCP is on — list it here only otherwise.
    if (!agent.mcp && httpTools.length) {
      lines.push("", "Tools:", "");
      for (const t of httpTools) {
        const gate = t.requiresPrincipal ? " (requires a signed-in user)" : "";
        lines.push(`- \`${t.id}(${paramList(t.input)})\`${gate} — ${t.description.replace(/\s+/g, " ").trim()}`);
      }
    }
    const first = httpTools[0];
    if (first) {
      lines.push(
        "",
        "Call a tool:",
        "",
        "```sh",
        `curl -s ${origin}${apiActionPath(first.id)} -H 'content-type: application/json' -d '{}'`,
        "```",
        "",
        "(Send the input per the tool's schema in /openapi.json.)",
      );
    }
  }
  return {
    name,
    description,
    url: `${origin}/.well-known/agent-skills/${name}/SKILL.md`,
    markdown: lines.join("\n") + "\n",
  };
}

// sha256:{64 lowercase hex} of the UTF-8 bytes — the digest a client verifies the
// downloaded SKILL.md against, so it MUST be computed over the served string.
export async function sha256Digest(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "sha256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function agentSkillsIndex(
  origin: string,
  agent: AgentConfig,
  site?: { name?: string; description?: string },
) {
  const skill = siteSkill(origin, agent, site);
  return {
    $schema: AGENT_SKILLS_SCHEMA,
    skills: [
      {
        name: skill.name,
        type: "skill-md",
        description: skill.description,
        url: skill.url,
        digest: await sha256Digest(skill.markdown),
      },
    ],
  };
}

// --- ARD / AI Catalog ---------------------------------------------------------
// One catalog of the app's agentic resources (MCP server, skills), per the AI
// Catalog data model (github.com/Agent-Card/ai-catalog) that ARD
// (agenticresourcediscovery.org) crawls. Served at BOTH /.well-known/ai-catalog.json
// (AI Catalog's well-known path) and /.well-known/ard.json (ARD's), as
// application/json with CORS open — the shape ARD's publishing guide prescribes.
// representativeQueries are omitted: they are optional, and a framework cannot
// write honest example queries for an app it knows only by its tool list.
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";
export const ARD_PATH = "/.well-known/ard.json";

export function aiCatalog(
  origin: string,
  agent: AgentConfig,
  site?: { name?: string; description?: string },
) {
  const host = new URL(origin).host;
  const hostname = new URL(origin).hostname;
  const urn = (namespace: string, name: string) => `urn:air:${hostname}:${namespace}:${name}`;
  const entries: Array<Record<string, unknown>> = [];
  for (const s of agentServices(origin, agent, site)) {
    if (!s.catalog) continue;
    entries.push({
      // the site's own name within the namespace: urn:air:june.build:mcp:june-build
      identifier: urn(s.catalog.namespace, skillName(origin)),
      displayName: s.catalog.displayName,
      type: s.catalog.type,
      url: s.catalog.url,
      ...(site?.description ? { description: site.description } : {}),
    });
  }
  const skill = siteSkill(origin, agent, site);
  entries.push({
    identifier: urn("skill", skill.name),
    displayName: `Using ${siteLabel(origin, site)}`,
    type: "application/agent-skills+md",
    url: skill.url,
    description: skill.description,
  });
  return {
    specVersion: "1.0",
    host: {
      displayName: siteLabel(origin, site),
      // did:web encodes a port's colon as %3A (did:web spec §3.1).
      identifier: `did:web:${host.replace(":", "%3A")}`,
      documentationUrl: `${origin}/llms.txt`,
    },
    entries,
  };
}

const ICON_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

// The card's icons, from the same set the document links: the primary favicon
// (site.icon, the app's own, else June's letter /favicon.svg), the 32×32 PNG, and
// June's generated 192/512 PNGs.
// Every src is resolved the way the document's <link> resolves it: basePath applies
// to root-relative paths only (withBasePath), then URL resolution against the
// site root handles absolute, protocol-relative ("//cdn…") and relative ("icon.png").
function cardIcons(origin: string, site: SiteConfig, docIcons: DocumentConfig["icons"], basePath = "") {
  const siteRoot = `${origin}${basePath}/`;
  const abs = (u: string) => new URL(withBasePath(u, basePath)!, siteRoot).href;
  const icon = (src: string, sizes?: string[]) => {
    const mimeType = ICON_TYPES[src.split(/[?#]/)[0]!.split(".").pop()!.toLowerCase()];
    return { src: abs(src), ...(mimeType ? { mimeType } : {}), ...(sizes ? { sizes } : {}) };
  };
  const primary = site.icon ?? docIcons?.primary ?? "/favicon.svg";
  const icons = [icon(primary, primary.endsWith(".svg") ? ["any"] : undefined)];
  if (docIcons?.png && docIcons.png !== primary) icons.push(icon(docIcons.png, ["32x32"]));
  if (docIcons?.generated) icons.push(icon("/icon-192.png", ["192x192"]), icon("/icon-512.png", ["512x512"]));
  return icons;
}

// The MCP Server Card (SEP-2127, schema v1): identity + where and how to connect,
// so a client can configure itself before opening a transport. Its identity is the
// SAME mcpServerIdentity the initialize handshake reports.
// `url`, `protocolVersion`, `capabilities`, and `tools` predate the v1 schema (which
// leaves primitives to live tools/list); they stay for clients and scanners that
// read the earlier draft shape.
export function mcpServerCard(
  origin: string,
  opts: {
    site?: SiteConfig;
    agent?: Pick<AgentConfig, "discovery" | "mcpServer">;
    icons?: DocumentConfig["icons"];
    basePath?: string;
  } = {},
) {
  const site = opts.site ?? {};
  const id = mcpServerIdentity(origin, { site, agent: opts.agent });
  const tools = toolNames();
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: id.name,
    ...(id.title ? { title: id.title } : {}),
    version: id.version,
    // Every path is fitted to the schema's 100 chars: id.description already is,
    // and the host-based fallback goes through the same fitCardText.
    description:
      id.description ??
      fitCardText(`The MCP server for ${new URL(origin).host}: ${tools.length} tool${tools.length === 1 ? "" : "s"}.`),
    websiteUrl: `${origin}/`,
    icons: cardIcons(origin, site, opts.icons, opts.basePath),
    remotes: [{ type: "streamable-http", url: `${origin}/mcp`, supportedProtocolVersions: [PROTOCOL_VERSION] }],
    url: `${origin}/mcp`,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    tools,
  };
}
