import { afterEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, defineAction } from "junecore/agent";
import { resolveAgent } from "junecore/config";
import {
  apiCatalog,
  buildLinkHeader,
  llmsTxt,
  mcpServerCard,
  robotsTxt,
  sitemapXml,
} from "junecore/discovery";

const ORIGIN = "https://example.com";

afterEach(() => ACTION_REGISTRY.clear());

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
    expect(txt).toContain("`junecore`");
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
});

describe("sitemapXml()", () => {
  test("includes static routes and skips dynamic templates", () => {
    const xml = sitemapXml(ORIGIN, ["/", "/posts", "/posts/[slug]"]);
    expect(xml).toContain(`<loc>${ORIGIN}/posts</loc>`);
    expect(xml).not.toContain("[slug]");
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
