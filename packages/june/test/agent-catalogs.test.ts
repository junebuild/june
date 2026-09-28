// Where the agent catalogs (ARD ai-catalog, Agent Skills) are published — and so
// where a page may advertise them. One rule (the pipeline's catalogOrigin): a
// catalog exists only at a domain root with a nameable public origin, and the
// <link rel="ai-catalog"> head link appears only where the catalog does.
import { describe, expect, test } from "bun:test";
import React from "react";

import { resolveAgent } from "@junejs/core/config";
import { PRERENDER_ORIGIN, type DocumentConfig } from "@junejs/core/document";
import { route } from "@junejs/core/route";

import { createPipeline } from "../src/pipeline";

const base: DocumentConfig = {
  site: { name: "T" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: false,
};

const pipeline = (doc: Partial<DocumentConfig>, agent = resolveAgent(undefined)) => {
  const p = createPipeline({
    docConfig: { ...base, ...doc },
    agent,
    routeList: () => ["/"],
    // Every path resolves to a page, like an app catch-all would — so a catalog
    // path that isn't published answers as that page, never as a catalog.
    resolve: async () => ({
      def: route({ view: () => React.createElement("p", null, "hi"), json: () => ({ page: true }) }),
      params: {},
      chain: [],
    }),
  });
  return (url: string, method = "GET") => p.fetch(new Request(url, { method }));
};

const LINK = '<link rel="ai-catalog"';
const isCatalog = async (res: Response) => {
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const body = (await res.json()) as Record<string, unknown>;
  return "specVersion" in body || "$schema" in body;
};

describe("agent catalog publication", () => {
  test("a live root deploy serves the catalog and links it", async () => {
    const get = pipeline({});
    expect(await isCatalog(await get("https://app.example/.well-known/ai-catalog.json"))).toBe(true);
    expect(await (await get("https://app.example/")).text()).toContain(LINK);
    expect((await get("https://app.example/")).headers.get("link")).toContain('rel="ai-catalog"');
    expect(await (await get("https://app.example/robots.txt")).text()).toContain("Agentmap:");
  });

  test("a basePath site publishes no catalog and links none (it doesn't own /.well-known)", async () => {
    const get = pipeline({ basePath: "/base", deployOrigin: "https://app.example" });
    expect(await isCatalog(await get("https://app.example/.well-known/ai-catalog.json"))).toBe(false);
    expect(await isCatalog(await get("https://app.example/.well-known/agent-skills/index.json"))).toBe(false);
    expect(await (await get("https://app.example/")).text()).not.toContain(LINK);
    expect(await (await get(`${PRERENDER_ORIGIN}/`)).text()).not.toContain(LINK);
    // …nor in the Link header or robots.txt — every advertisement follows the one rule
    const link = (await get("https://app.example/")).headers.get("link");
    expect(link).toContain('rel="llms-txt"'); // the rest of the discovery tree stays
    expect(link).not.toContain('rel="ai-catalog"');
    expect(await (await get("https://app.example/robots.txt")).text()).not.toContain("Agentmap:");
  });

  test("agent.discovery off publishes and links nothing, live or prerendered", async () => {
    const get = pipeline({ deployOrigin: "https://app.example" }, resolveAgent({ discovery: false }));
    for (const origin of ["https://app.example", PRERENDER_ORIGIN]) {
      expect(await isCatalog(await get(`${origin}/.well-known/ai-catalog.json`))).toBe(false);
      expect(await (await get(`${origin}/`)).text()).not.toContain(LINK);
    }
  });

  test("HEAD on every discovery surface: GET's status and headers, no body (Agent Skills RFC: GET and HEAD)", async () => {
    const get = pipeline({});
    const index = (await (await get("https://app.example/.well-known/agent-skills/index.json")).json()) as any;
    const paths = [
      "/llms.txt",
      "/robots.txt",
      "/sitemap.xml",
      "/.well-known/api-catalog",
      "/.well-known/mcp/server-card.json",
      "/.well-known/ai-catalog.json",
      "/.well-known/ard.json",
      "/.well-known/agent-skills/index.json",
      new URL(index.skills[0].url).pathname,
    ];
    for (const path of paths) {
      const url = `https://app.example${path}`;
      const [g, h] = await Promise.all([get(url), get(url, "HEAD")]);
      expect(g.status).toBe(200);
      expect(h.status).toBe(200);
      expect(h.headers.get("content-type")).toBe(g.headers.get("content-type"));
      expect(h.headers.get("access-control-allow-origin")).toBe(g.headers.get("access-control-allow-origin"));
      expect(await h.text()).toBe("");
    }
  });

  test("an unknown skill path 404s while skills are served, even past an app catch-all (RFC: 404 for skills that don't exist)", async () => {
    const get = pipeline({}); // the resolver answers EVERY path with a 200 page
    for (const p of ["/.well-known/agent-skills/nope/SKILL.md", "/.well-known/agent-skills/", "/.well-known/agent-skills/x.tar.gz"]) {
      const res = await get(`https://app.example${p}`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error).toBe("Not Found");
      expect((await get(`https://app.example${p}`, "HEAD")).status).toBe(404);
    }
  });

  test("when skills aren't served, the path stays the app's (falls through to routing)", async () => {
    for (const get of [
      pipeline({ basePath: "/base" }),
      pipeline({}, resolveAgent({ discovery: false })),
    ]) {
      // (the catch-all answers it — here as its `.md` projection of the page)
      const res = await get("https://app.example/.well-known/agent-skills/nope/SKILL.md");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('"page": true');
    }
  });

  test("a prerender without a public origin publishes and links nothing", async () => {
    const get = pipeline({});
    expect(await isCatalog(await get(`${PRERENDER_ORIGIN}/.well-known/ai-catalog.json`))).toBe(false);
    expect(await (await get(`${PRERENDER_ORIGIN}/`)).text()).not.toContain(LINK);
  });

  test("a prerender with a public origin names it, and links the catalog", async () => {
    const get = pipeline({ deployOrigin: "https://app.example" });
    const cat = (await (await get(`${PRERENDER_ORIGIN}/.well-known/ai-catalog.json`)).json()) as any;
    expect(cat.host.identifier).toBe("did:web:app.example");
    expect(await (await get(`${PRERENDER_ORIGIN}/`)).text()).toContain(LINK);
  });
});
