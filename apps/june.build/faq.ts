// The homepage FAQ — ONE source for the rendered section (app/page.tsx), the
// homepage's .md projection (app/content.ts), and the FAQPage JSON-LD node
// (june.config.ts site.jsonLd). Answers are plain text; `code` spans render as
// <code> in HTML and stay as-is in Markdown, and are stripped for JSON-LD.
// Every answer must stay true of the shipped framework — cite the docs page.

export type Faq = { q: string; a: string };

export const FAQ: Faq[] = [
  {
    q: "What is June?",
    a:
      "An open-source (MIT) React framework for apps that serve people and AI agents at once. One route " +
      "renders HTML for people and also answers as Markdown and JSON; an action you define with " +
      "`defineAction()` and a `description` is also an MCP tool at `/mcp` and, when its id is URL-safe, " +
      "a `POST /api/<id>` operation in `/openapi.json`.",
  },
  {
    q: "How is June different from a chatbot builder or an agent framework?",
    a:
      "June is not a hosted chatbot or a separate agent runtime. The agent lives inside your app: an " +
      "`agent/` directory declares it, its tools are your app's own actions exported into `agent/tools/`, " +
      "and the same authorization check covers a person clicking a button and an agent calling the tool.",
  },
  {
    q: "Which npm packages are June's?",
    a:
      "`@junejs/core` (the framework), `@junejs/server` and `@junejs/cli`; start a new app with " +
      "`npm create june my-app`. The `june` package and the `@june/*` scope on npm are unrelated projects.",
  },
  {
    q: "Where can I deploy a June app?",
    a:
      "Cloudflare Workers (the default), Vercel and Deno Deploy ship today, and a static export works on " +
      "any file host such as GitHub Pages. Self-hosting on Bun or Node serves the same pipeline; a " +
      "production `june start` command is on the roadmap.",
  },
  {
    q: "Do agent turns survive a restart or a redeploy?",
    a:
      "With a persistent store, yes: every turn is recorded step by step, so a process backed by a " +
      "mounted SQLite file or by Durable Objects on Workers resumes where it left off. The default " +
      "in-memory store keeps turns only while the process runs.",
  },
  {
    q: "Is June ready for production?",
    a:
      "June is a 0.0.x preview. Routes and projections, `defineAction()`, and the `/mcp` and discovery " +
      "surfaces are stable; the agent layer (agent/, channels, connections), the data layer and auth are " +
      "still changing. The stability page at june.build/docs/stability tracks each surface.",
  },
];

// FAQ as Markdown (the homepage .md projection appends it).
export function faqMarkdown(): string {
  return ["## FAQ", ...FAQ.map((f) => `### ${f.q}\n\n${f.a}`)].join("\n\n") + "\n";
}

// FAQ as a schema.org FAQPage node for the homepage JSON-LD @graph.
export function faqJsonLd(id: string) {
  return {
    "@type": "FAQPage",
    "@id": id,
    mainEntity: FAQ.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a.replace(/`/g, "") },
    })),
  };
}
