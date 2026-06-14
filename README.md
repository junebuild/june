# June

**The agent-ready React framework.** One page definition serves humans
(streamed HTML, zero client JS) and agents (markdown, JSON, MCP) — nothing
drifts, because nothing is duplicated.

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
`llms.txt`, sitemap, and an API catalog derive from the route graph
automatically.

## What's in the box

- **[Built-in MCP](https://june.build/docs/features-mcp)** — your app is an MCP server, no adapter
- **[Markdown without drift](https://june.build/docs/features-markdown)** — `.md` serves your authored source
- **[og:images as routes](https://june.build/docs/features-og-image)** — satori + resvg in the worker, CJK-ready
- **[Server-first RSC](https://june.build/docs/features-rsc)** + **[islands](https://june.build/docs/features-islands)** — zero client JS until a subtree earns it
- **[App Router](https://june.build/docs/features-app-router)** — `[slug]`, `[[optional]]`, `[...catchAll]`, `(groups)`, nested [layouts](https://june.build/docs/features-layouts)
- **[Browser-native navigation](https://june.build/docs/features-navigation)** — Speculation Rules + View Transitions, no router by default
- **[Opt-in client router](https://june.build/docs/features-client-router)** — `clientRouter: true` adds soft swaps + `<Island persist>` when state must outlive a navigation
- **[Web Standards end to end](https://june.build/docs/features-web-standards)** — `fetch(Request) → Response` *is* the framework
- **[Reload-on-save dev loop](https://june.build/docs/features-dx)** — server restarts, browser follows
- **[Deploy](https://june.build/docs/04-deployment)** — `june deploy` → Cloudflare Workers today; the host seam makes other targets adapters

Every docs page is also markdown — append `.md` to any
[june.build](https://june.build) URL. The site is built with June and is its
own demo.

## Honest limits (so you can calibrate)

No streamed Suspense fallbacks yet, no Flight-payload navigation, and the
Rust+V8 runtime numbers on the site are an experimental track — today's host
is Bun/Node, deploying to Workers. The full list lives on
[june.build/why](https://june.build/why).

## This repository

```txt
packages/core         @junejs/core — the pure contract layer (zero node:*, enforced)
packages/june         @junejs/server — host adapters, dev server, build, deploy
packages/cli          @junejs/cli — the `june` command
packages/juno         @junejs/juno — the default data layer
packages/create-june  the scaffolder
apps/june.build       the framework site, dogfooded on June
examples/             fixtures (the golden dev ≡ built-worker parity contract)
docs/                 architecture notes
```

```bash
bun install
bun run ci     # typecheck + the full suite (incl. parity + packed-artifact E2E)
```

## License

[MIT](./LICENSE) © June.build
