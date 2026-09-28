# June

**The React framework for building agents into real apps.** One definition
serves humans (streamed HTML, zero client JS) and agents (markdown, JSON, MCP) —
nothing drifts, because nothing is duplicated. An agent is a feature, not a
separate runtime: its tools are your server actions, its API is the `/mcp` your
app already speaks.

> **Status: 0.0.x preview.** The spec is still being drafted and APIs will
> change. Early feedback is the point — [open an issue](https://github.com/junebuild/june/issues).

## Quick start

```bash
npm create june@latest my-app
cd my-app && npm install
npm run dev          # → http://localhost:3000
```

The scaffolder runs on Node; the `june` CLI runs on [Bun](https://bun.sh) (≥ 1.3).

You get a working app, not a blank page:

```txt
my-app/
  app/
    page.tsx          # one page — also answers /.json and /.md
    users/page.tsx    # a second route with a defineAction() → an MCP tool
    layout.tsx        # wraps every page (nested layouts compose root → leaf)
    Counter.tsx       # a client island — the ONE subtree that hydrates
    _client.tsx       # the island registry; its presence enables /client.js
  db/migrations/      # plain SQL — the SQL you read is the SQL that runs
  AGENTS.md           # guidance for the coding agent working in this app
  june.config.ts      # exists to turn things OFF — defaults are on
  package.json
```

Then try both audiences:

```bash
curl localhost:3000/.md        # the page you just saw, as markdown
curl -X POST localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
npx june info                  # routes + the agent surface, at a glance
```

## One definition, every surface

A page's default export is the view; named exports configure the other
surfaces. `.json` auto-derives from the loader data:

```tsx
import type { RouteContext, Loaded } from "@junejs/core/route";

export const loader = (ctx: RouteContext<{ slug: string }>) => fetchPost(ctx.params.slug);

export default function Post(post: Loaded<typeof loader>) {  // GET /posts/x      → streamed HTML
  return <article>…</article>;
}

export const md = (post: Loaded<typeof loader>) => post.original;  // GET /posts/x.md → authored markdown
// GET /posts/x.json → the loader data, auto-derived
```

And one `defineAction()` is simultaneously a server action for your UI **and**
an MCP tool at `/mcp` — same `run(input, ctx)`, same authorization gate.
Export it from `agent/tools/` and it's your own agent's tool too.
`llms.txt`, sitemap, and an API catalog derive from the route graph
automatically.

## What's in the box

- **[Agents](https://june.build/docs/agents-overview)** — an `agent/` directory is an agent: your actions as its tools, Slack / Crisp / HTTP [channels](https://june.build/docs/agents-channels), MCP / OpenAPI / Google Drive [connections](https://june.build/docs/agents-connections), and [durable turns](https://june.build/docs/agents-durable-turns) that park for a human and resume — on SQLite in dev, one Durable Object per session on Workers
- **[Built-in MCP](https://june.build/docs/features-mcp)** — your app is an MCP server, no adapter
- **[Markdown without drift](https://june.build/docs/features-markdown)** — `.md` serves your authored source; HTML headings get GitHub-compatible ids
- **[og:images as routes](https://june.build/docs/features-og-image)** — satori + resvg in the worker, CJK-ready
- **[Ambient data + cache magic](https://june.build/docs/features-data)** — `import { db }`, explicit SQL migrations; a write auto-invalidates cached reads
- **[Server-first RSC](https://june.build/docs/features-rsc)** + **[islands](https://june.build/docs/features-islands)** — zero client JS until a subtree earns it
- **[Styling](https://june.build/docs/features-styling)** — `app/global.css` auto-linked, Tailwind v4 + CSS Modules, hashed & minified on build
- **[App Router](https://june.build/docs/features-app-router)** — `[slug]`, `[[optional]]`, `[...catchAll]`, `(groups)`, nested [layouts](https://june.build/docs/features-layouts)
- **[Browser-native navigation](https://june.build/docs/features-navigation)** — Speculation Rules + View Transitions, no router by default
- **[Opt-in client router](https://june.build/docs/features-client-router)** — `clientRouter: true` adds soft swaps + `<Island persist>` when state must outlive a navigation
- **[Web Standards end to end](https://june.build/docs/features-web-standards)** — `fetch(Request) → Response` *is* the framework
- **[Reload-on-save dev loop](https://june.build/docs/features-dx)** — server restarts, browser follows
- **[Deploy](https://june.build/docs/deployment)** — `june deploy` to Cloudflare Workers, Vercel, or Deno Deploy, or `staticSite()` for a static export — each an adapter over one host seam

Every docs page is also markdown — append `.md` to any
[june.build](https://june.build) URL. The site is built with June and is its
own demo.

## Honest limits (so you can calibrate)

Streaming is opt-in: a route streams its Suspense fallback only when it has a
`loading.tsx` and static metadata — otherwise the page flushes fully resolved.
No Flight-payload navigation yet: its client half exists, but the server
doesn't render a flight projection, so `clientRouter: "flight"` falls back to
full navigations. The agent layer, the data layer, and auth still change between
releases. The Rust+V8
runtime numbers on the site are an experimental track; today's host is
Bun/Node. Where each piece stands lives on
[june.build/docs/stability](https://june.build/docs/stability).

## This repository

```txt
packages/core         @junejs/core — the pure contract layer (zero node:*, enforced)
packages/june         @junejs/server — host adapters, dev server, build, deploy
packages/cli          @junejs/cli — the `june` command
packages/db           @junejs/db — ambient db/kv/blob (request-scoped, edge-safe)
packages/juno         @junejs/juno — the default data layer
packages/og           @junejs/og — og:image generation, one import on Workers, Vercel Edge, and Node dev
packages/i18n         @junejs/i18n — ICU messages with a typed t()
packages/create-june  the scaffolder
apps/june.build       the framework site, dogfooded on June
examples/             fixtures (the golden dev ≡ built-worker parity contract)
docs/                 architecture notes
```

```bash
bun install
bun run ci                        # typecheck + the full test suite (incl. dev ≡ built-worker parity)
bash scripts/smoke-packed.sh      # the published tarballs, as an npm user gets them
bun scripts/smoke-workerd.ts      # the built worker on workerd, the runtime production runs
```

## License

[MIT](./LICENSE) © June.build
