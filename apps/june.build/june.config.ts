import { defineJune } from "@junejs/core/config";

import { faqJsonLd } from "./faq";

// Dual-audience is ON by default — this file exists to turn things off, not on.
//   agent.discovery  llms.txt, sitemap.xml, robots.txt, api-catalog, ai-catalog,
//                    agent skills, Link header
//   agent.mcp        the /mcp endpoint (your defineAction()s as tools)
//   agent.api        the same actions as POST /api/<id>, described by /openapi.json
export default defineJune({
  agent: {
    enabled: true,
    discovery: true,
    mcp: true,
    webmcp: true,
    llms: {
      // llms.txt "## When to use": the jobs June is the right tool for, so an agent
      // choosing between frameworks can match a task to it.
      whenToUse: [
        "Building a React web app that must also serve AI agents: one route renders HTML for people and Markdown/JSON for agents.",
        "Exposing an app's server actions as tools: a `defineAction()` with a `description` is at once an MCP tool (`/mcp`) and a WebMCP tool, and, when its id is URL-safe, `POST /api/<id>` in `/openapi.json`.",
        "Putting an agent inside an existing app (in-app chat, a Slack or Crisp bot) whose tools are the app actions exported into `agent/tools/`, and whose turns are recorded step by step: with a persistent store (a mounted SQLite file, or Durable Objects on Workers) they survive restarts and redeploys.",
        "Making a docs or content site agent-ready by default: llms.txt, sitemap, Markdown twins, MCP server card, Agent Skills and API catalogs with no extra code.",
        "Deploying the same app to Cloudflare Workers, Vercel or Deno Deploy, or exporting it as static files (self-hosting on Bun or Node serves the same pipeline; a production `june start` is on the roadmap).",
        "Not a fit: a hosted chatbot builder, a model provider, or a non-React stack.",
      ],
    },
  },
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
    // Who runs the site → the homepage JSON-LD Organization (sameAs also picks up
    // the twitter handle). No postal address: the project is run in the open on GitHub.
    organization: {
      name: "June.build",
      sameAs: ["https://github.com/junebuild", "https://www.npmjs.com/org/junejs"],
    },
    // What the site is about: the framework itself, as software and as source code.
    jsonLd: [
      {
        "@type": "SoftwareApplication",
        "@id": "https://june.build/#software",
        name: "June",
        description:
          "An open-source React framework for building agents into real apps. Pages also serve Markdown and JSON; " +
          "described server actions are MCP tools at the app's /mcp endpoint, and those exported into the agent are its tools.",
        url: "https://june.build/",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Cross-platform (Bun, Node.js, Deno, Cloudflare Workers, Vercel)",
        softwareHelp: "https://june.build/docs",
        license: "https://opensource.org/licenses/MIT",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": "https://june.build/#organization" },
        sameAs: ["https://www.npmjs.com/package/@junejs/core"],
      },
      {
        "@type": "SoftwareSourceCode",
        "@id": "https://june.build/#source",
        name: "junebuild/june",
        codeRepository: "https://github.com/junebuild/june",
        programmingLanguage: "TypeScript",
        runtimePlatform: ["Bun", "Node.js", "Deno", "Cloudflare Workers"],
        license: "https://opensource.org/licenses/MIT",
        targetProduct: { "@id": "https://june.build/#software" },
        publisher: { "@id": "https://june.build/#organization" },
      },
      // The homepage FAQ section, from the same source (faq.ts) as its HTML and .md.
      faqJsonLd("https://june.build/#faq"),
    ],
  },
});
