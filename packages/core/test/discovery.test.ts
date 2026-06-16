import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, defineAction } from "@junejs/core/agent";
import { resolveAgent } from "@junejs/core/config";
import {
  apiCatalog,
  buildLinkHeader,
  llmsTxt,
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
});
