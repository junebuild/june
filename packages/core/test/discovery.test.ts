import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, defineAction } from "@junejs/core/agent";
import { resolveAgent } from "@junejs/core/config";
import {
  apiCatalog,
  buildLinkHeader,
  llmsTxt,
  type LlmsLink,
  MCP_SERVER_CARD_TYPE,
  mcpServerCard,
  robotsTxt,
  sitemapXml,
} from "@junejs/core/discovery";

const ORIGIN = "https://example.com";

// Each test runs against an empty registry, but the surrounding state is
// restored after: bun caches modules across test files, so registrations other
// files rely on (e.g. the fixture actions the CLI warmup test reads) cannot be
// re-created by a later import — leaving the registry cleared would leak the
// loss into every file that runs after this one.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => {
  preexisting = new Map(ACTION_REGISTRY);
  ACTION_REGISTRY.clear();
});
afterEach(() => {
  ACTION_REGISTRY.clear();
  for (const [id, action] of preexisting) ACTION_REGISTRY.set(id, action);
});

describe("buildLinkHeader()", () => {
  test("advertises the whole discovery tree; drops mcp-server when mcp is off", () => {
    const full = buildLinkHeader(resolveAgent());
    expect(full).toContain(`rel="llms-txt"`);
    expect(full).toContain(`rel="mcp-server"`);

    const noMcp = buildLinkHeader(resolveAgent({ mcp: false }));
    expect(noMcp).not.toContain(`rel="mcp-server"`);
  });

  test("every advertisement of the server card names the media type it is served with", () => {
    expect(MCP_SERVER_CARD_TYPE).toBe("application/mcp-server-card+json");
    expect(buildLinkHeader(resolveAgent())).toContain(
      `</.well-known/mcp/server-card.json>; rel="mcp-server"; type="${MCP_SERVER_CARD_TYPE}"`,
    );
    expect(apiCatalog(ORIGIN, resolveAgent()).linkset[0]?.["service-desc"]).toEqual([
      { href: `${ORIGIN}/.well-known/mcp/server-card.json`, type: MCP_SERVER_CARD_TYPE },
    ]);
  });

  test("returns null when discovery is disabled", () => {
    expect(buildLinkHeader(resolveAgent({ enabled: false }))).toBeNull();
  });
});

describe("llmsTxt()", () => {
  test("always ships the canonical-names stanza (reminder #6)", () => {
    const txt = llmsTxt(ORIGIN, ["/", "/posts"], resolveAgent(), { name: "Blog" });
    expect(txt).toContain("canonical names — do not guess");
    expect(txt).toContain("`@junejs/core`");
    expect(txt).toContain("NOT `june`");
    expect(txt).toContain("@junejs");
  });

  test("lists routes and MCP tools when mcp is on", () => {
    defineAction({
      id: "createPost",
      description: "Create a post",
      input: { type: "object", properties: {} },
      run: () => ({}),
    });
    const txt = llmsTxt(ORIGIN, ["/posts"], resolveAgent());
    expect(txt).toContain("- [/posts](/posts)");
    expect(txt).toContain(`MCP server: ${ORIGIN}/mcp`);
    expect(txt).toContain("- tool: createPost");
  });

  test("advertises WebMCP statically (the read-the-signal discovery path)", () => {
    defineAction({
      id: "createPost",
      description: "Create a post",
      input: { type: "object", properties: {} },
      run: () => ({}),
    });
    const on = llmsTxt(ORIGIN, ["/posts"], resolveAgent());
    expect(on).toContain("Tools (WebMCP, in-browser)");
    expect(on).toContain("navigator.modelContext.registerTool()");
    expect(on).toContain("defineAction"); // names the June way to add one
    // webmcp off → no WebMCP stanza (gating mirrors the document injection)
    const off = llmsTxt(ORIGIN, ["/posts"], resolveAgent({ webmcp: false }));
    expect(off).not.toContain("WebMCP");
  });
});

describe("llmsTxt() with route links (llmstxt.org sections)", () => {
  const link = (title: string, section: string, extra: Partial<LlmsLink> = {}): LlmsLink => ({
    title,
    url: `${ORIGIN}/${title.toLowerCase()}.md`,
    section,
    optional: false,
    ...extra,
  });

  test("groups links under H2 sections in first-seen order, each '- [title](url): description'", () => {
    const txt = llmsTxt(ORIGIN, [], resolveAgent({ mcp: false }), { name: "Docs" }, [
      link("Intro", "Get started", { description: "Start here." }),
      link("Auth", "Concepts"),
      link("Deploy", "Get started"),
    ]);
    const body = txt.slice(txt.indexOf("## Get started"));
    expect(body).toBe(
      "## Get started\n" +
        `- [Intro](${ORIGIN}/intro.md): Start here.\n` +
        `- [Deploy](${ORIGIN}/deploy.md)\n` +
        "\n## Concepts\n" +
        `- [Auth](${ORIGIN}/auth.md)\n`,
    );
    expect(txt).not.toContain("## Routes"); // the legacy flat list is replaced, not duplicated
  });

  test('"## Optional" is always last among the link sections, even when seen first', () => {
    const txt = llmsTxt(ORIGIN, [], resolveAgent({ mcp: false }), undefined, [
      link("Post", "Blog", { optional: true }),
      link("Intro", "Docs"),
    ]);
    expect(txt.indexOf("## Docs")).toBeLessThan(txt.indexOf("## Optional"));
    expect(txt).not.toContain("## Blog"); // an optional link is filed under Optional, not its section
  });

  test('"## Optional" is the file\'s LAST H2 — after the MCP / WebMCP tool sections too', () => {
    const txt = llmsTxt(ORIGIN, [], resolveAgent(), undefined, [link("Intro", "Docs"), link("Post", "Blog", { optional: true })]);
    const h2s = [...txt.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(h2s).toContain("Tools (MCP)"); // mcp on (the default): tools are present…
    expect(h2s.at(-1)).toBe("Optional"); // …and still come before the skippable section
  });

  test('a section literally named "Optional" is the reserved Optional section — never mid-file', () => {
    // optional: false, but filed under llmstxt.org's reserved name — and seen FIRST
    const txt = llmsTxt(ORIGIN, [], resolveAgent(), undefined, [link("Aside", "Optional"), link("Intro", "Docs")]);
    const h2s = [...txt.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(h2s.filter((h) => h === "Optional")).toHaveLength(1); // one Optional, not two
    expect(h2s.at(-1)).toBe("Optional");
    expect(h2s.indexOf("Docs")).toBeLessThan(h2s.indexOf("Optional"));
    expect(txt.slice(txt.indexOf("## Optional"))).toContain("[Aside]");
  });

  test("app-authored agent.llms.sections still appear — before Optional (Kura's compat path)", () => {
    const agent = resolveAgent({ mcp: false, llms: { sections: ["## Custom", "- [x](/x)"] } });
    const txt = llmsTxt(ORIGIN, [], agent, undefined, [link("Intro", "Docs"), link("Post", "Blog", { optional: true })]);
    const docs = txt.indexOf("## Docs");
    const custom = txt.indexOf("## Custom");
    const optional = txt.indexOf("## Optional");
    expect(docs).toBeGreaterThan(-1);
    expect(docs).toBeLessThan(custom);
    expect(custom).toBeLessThan(optional);
  });

  test("brackets in a title are escaped so the markdown link stays intact", () => {
    const txt = llmsTxt(ORIGIN, [], resolveAgent({ mcp: false }), undefined, [link("Use [slug] routes", "Docs")]);
    expect(txt).toContain("- [Use \\[slug\\] routes](");
  });
});

describe("sitemapXml()", () => {
  test("includes static routes and skips dynamic templates", () => {
    const xml = sitemapXml(ORIGIN, ["/", "/posts", "/posts/[slug]"]);
    expect(xml).toContain(`<loc>${ORIGIN}/posts</loc>`);
    expect(xml).not.toContain("[slug]");
    expect(xml).not.toContain("xhtml"); // no i18n → no alternates namespace
  });

  test("with i18n, each url carries xhtml:link hreflang alternates", () => {
    const xml = sitemapXml(ORIGIN, ["/about"], {
      defaultLocale: "en",
      locales: { en: {}, de: { path: "/de" }, fr: { domain: "example.fr" } },
    });
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain(`<loc>${ORIGIN}/about</loc>`);
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="de" href="${ORIGIN}/de/about"/>`);
    // a cross-origin locale stays absolute on its own host
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="fr" href="https://example.fr/about"/>');
    expect(xml).toContain('hreflang="x-default"');
  });

  test("a page's lastModified becomes <lastmod>; a bad value is dropped, never emitted", () => {
    const xml = sitemapXml(ORIGIN, [
      { path: "/a", lastModified: "2026-09-27" },
      { path: "/b", lastModified: new Date("2026-06-12") }, // YAML `date:` → UTC midnight → plain date
      { path: "/c", lastModified: new Date("2026-06-12T08:30:00Z") },
      { path: "/d", lastModified: "last tuesday" },
      "/e",
      { path: "/f", lastModified: "2026-02-30" }, // Date.parse would roll this to March 2
      { path: "/g", lastModified: "2026-13" },
      { path: "/h", lastModified: "2026-06-12T24:00Z" }, // ISO's next-midnight; W3C hours stop at 23
      { path: "/i", lastModified: "2026-06-12T10:00+24:00" },
      { path: "/j", lastModified: "2026-06-12T23:59:59+05:30" },
    ]);
    expect(xml).toContain(`<url><loc>${ORIGIN}/h</loc></url>`);
    expect(xml).toContain(`<url><loc>${ORIGIN}/i</loc></url>`);
    expect(xml).toContain(`<lastmod>2026-06-12T23:59:59+05:30</lastmod>`);
    expect(xml).toContain(`<url><loc>${ORIGIN}/f</loc></url>`);
    expect(xml).toContain(`<url><loc>${ORIGIN}/g</loc></url>`);
    expect(xml).toContain(`<url><loc>${ORIGIN}/a</loc><lastmod>2026-09-27</lastmod></url>`);
    expect(xml).toContain(`<url><loc>${ORIGIN}/b</loc><lastmod>2026-06-12</lastmod></url>`);
    expect(xml).toContain(`<lastmod>2026-06-12T08:30:00.000Z</lastmod>`);
    expect(xml).toContain(`<url><loc>${ORIGIN}/d</loc></url>`);
    expect(xml).toContain(`<url><loc>${ORIGIN}/e</loc></url>`);
  });

  test("with i18n, <lastmod> sits beside <loc>", () => {
    const xml = sitemapXml(ORIGIN, [{ path: "/about", lastModified: "2026-09-27" }], {
      defaultLocale: "en",
      locales: { en: {}, de: { path: "/de" } },
    });
    expect(xml).toContain(`<loc>${ORIGIN}/about</loc>\n    <lastmod>2026-09-27</lastmod>`);
  });
});

describe("llmsTxt() when-to-use", () => {
  test("agent.llms.whenToUse renders as ## When to use under the summary, before any other H2", () => {
    const agent = resolveAgent({ mcp: false, llms: { whenToUse: ["Building a React app with an AI agent", "Serving pages to agents as markdown"] } });
    const txt = llmsTxt(ORIGIN, ["/"], agent, { name: "Acme", description: "Acme things." });
    expect(txt).toContain("## When to use\n\n- Building a React app with an AI agent\n- Serving pages to agents as markdown\n");
    const h2s = [...txt.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(h2s[0]).toBe("When to use");
    expect(txt.indexOf("> Acme things.")).toBeLessThan(txt.indexOf("## When to use"));
  });

  test("absent → no section", () => {
    expect(llmsTxt(ORIGIN, ["/"], resolveAgent({ mcp: false }))).not.toContain("When to use");
  });
});

describe("robotsTxt() / apiCatalog() / mcpServerCard()", () => {
  test("robots.txt carries Content-Signal and Sitemap", () => {
    const txt = robotsTxt(ORIGIN);
    expect(txt).toContain("Content-Signal:");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  test("api-catalog is an RFC 9727 linkset, with service-desc only when mcp is on", () => {
    const cat = apiCatalog(ORIGIN, resolveAgent());
    expect(cat.linkset[0]?.anchor).toBe(`${ORIGIN}/`);
    expect(cat.linkset[0]?.["service-desc"]).toBeDefined();
    expect(apiCatalog(ORIGIN, resolveAgent({ mcp: false })).linkset[0]?.["service-desc"]).toBeUndefined();
  });

  test("mcp server card reports the protocol version and tool names", () => {
    defineAction({
      id: "ping",
      description: "Ping",
      input: { type: "object", properties: {} },
      run: () => ({}),
    });
    const card = mcpServerCard(ORIGIN);
    expect(card.url).toBe(`${ORIGIN}/mcp`);
    expect(card.protocolVersion).toBe("2025-06-18");
    expect(card.tools).toContain("ping");
  });

  test("mcp server card follows the v1 server-card schema, with identity from the site", () => {
    const card = mcpServerCard("https://june.build", {
      site: { name: "June — build agents into real apps", description: "The agent-native React framework." },
      icons: { png: "/favicon.png", generated: true },
    });
    expect(card).toMatchObject({
      $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
      name: "build.june/june",
      title: "June",
      version: "0.0.0",
      description: "The agent-native React framework.",
      websiteUrl: "https://june.build/",
      remotes: [{ type: "streamable-http", url: "https://june.build/mcp", supportedProtocolVersions: ["2025-06-18"] }],
    });
    // reverse-DNS with exactly one slash (schema pattern)
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(card.icons).toEqual([
      { src: "https://june.build/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
      { src: "https://june.build/favicon.png", mimeType: "image/png", sizes: ["32x32"] },
      { src: "https://june.build/icon-192.png", mimeType: "image/png", sizes: ["192x192"] },
      { src: "https://june.build/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
    ]);
  });

  test("mcp server card: site.icon wins, basePath prefixes, and a description is always present", () => {
    const card = mcpServerCard(ORIGIN, { site: { icon: "/brand.png" }, basePath: "/docs" });
    expect(card.icons).toEqual([{ src: `${ORIGIN}/docs/brand.png`, mimeType: "image/png" }]);
    expect(card.description).toContain("MCP server for");
  });

  test("mcp server card icons resolve like the document's <link>: protocol-relative, absolute, relative", () => {
    const src = (icon: string, basePath?: string) => mcpServerCard(ORIGIN, { site: { icon }, basePath }).icons[0]!.src;
    expect(src("//cdn.example/i.svg")).toBe("https://cdn.example/i.svg"); // protocol from the origin
    expect(src("https://cdn.example/i.svg", "/docs")).toBe("https://cdn.example/i.svg"); // untouched
    expect(src("icon.png")).toBe(`${ORIGIN}/icon.png`);
    expect(src("icon.png", "/docs")).toBe(`${ORIGIN}/docs/icon.png`); // relative → under the site root
    expect(src("//cdn.example/i.svg", "/docs")).toBe("https://cdn.example/i.svg"); // basePath never applies
  });

  test("the no-description fallback is fitted too — a long hostname can't push it past 100", () => {
    const host = `${"sub".repeat(25)}.example.com`; // 87-char host
    const card = mcpServerCard(`https://${host}`);
    expect(Array.from(card.description).length).toBeLessThanOrEqual(100);
    expect(card.description.startsWith("The MCP server for")).toBe(true);
  });

  test("mcp server card description and title stay within the v1 schema's 100 chars", () => {
    const card = mcpServerCard("https://june.build", {
      site: {
        name: `${"Very long product name ".repeat(6)}— tagline`,
        description:
          "The React framework where an agent is a feature, not a separate runtime: " +
          "your server actions are its tools, every turn is durable, and routes also serve MCP.",
      },
    });
    expect(Array.from(card.description).length).toBeLessThanOrEqual(100);
    expect(Array.from(card.title!).length).toBeLessThanOrEqual(100);
    expect(card.description.endsWith("…")).toBe(true);
  });
});
