import { defineJune } from "@junejs/core/config";

// Dual-audience is ON by default — this file exists to turn things off, not on.
//   agent.discovery  llms.txt, sitemap.xml, robots.txt, api-catalog, ai-catalog,
//                    agent skills, Link header
//   agent.mcp        the /mcp endpoint (your defineAction()s as tools)
//   agent.api        the same actions as POST /api/<id>, described by /openapi.json
export default defineJune({
  agent: { enabled: true, discovery: true, mcp: true, webmcp: true },
  // workers-og stays external: wrangler's own esbuild bundles it at deploy,
  // where its workerd-safe .wasm imports are first-class (CompiledWasm rules).
  build: { external: ["workers-og"] },
  deploy: { domain: "june.build" },
  site: {
    name: "June — build agents into real apps",
    titleTemplate: "%s · June",
    twitter: "@junebuild",
    // The dark theme's --s-bg (global.css): dark is the default; light is an
    // explicit toggle, not prefers-color-scheme, so one colour.
    themeColor: "#07080a",
    description:
      "The React framework where an agent is a feature, not a separate runtime: " +
      "your server actions are its tools, every turn is durable, and routes also serve MCP.",
  },
});
