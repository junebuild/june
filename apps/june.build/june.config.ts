import { defineJune } from "@junejs/core/config";

// Dual-audience is ON by default — this file exists to turn things off, not on.
//   agent.discovery  llms.txt, sitemap.xml, robots.txt, api-catalog, Link header
//   agent.mcp        the /mcp endpoint (your defineAction()s as tools)
export default defineJune({
  agent: { enabled: true, discovery: true, mcp: true, webmcp: true },
  // workers-og stays external: wrangler's own esbuild bundles it at deploy,
  // where its workerd-safe .wasm imports are first-class (CompiledWasm rules).
  build: { external: ["workers-og"] },
  site: {
    name: "June — the agent-ready React framework",
    titleTemplate: "%s · June",
    description:
      "One route() is a page, a JSON API, an MCP server, and an llms.txt entry. " +
      "Auth, data, and agent capabilities are one coherent model — point an agent " +
      "at /mcp and it acts as a scoped user.",
  },
});
