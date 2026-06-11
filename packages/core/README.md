# @junejs/core

The agent-native React framework. This package is the **pure, host-free
contract layer** — the most stable artifacts of the design, with zero `node:*`
or `Bun.*` (enforced by `test/purity.test.ts`).

| Subpath | What |
| --- | --- |
| `@junejs/core/route` | `route()` + content-negotiated projections (view/json/agent/md) |
| `@junejs/core/config` | config schema + pure resolvers (`defineJune`, `resolveAgent`, speculation rules) |
| `@junejs/core/document` | the shared HTML shell — one document drives dev + built worker (charset lives here) |
| `@junejs/core/agent` | the unified action registry: `defineAction`, `manifest`, `invokeAction` |
| `@junejs/core/discovery` | llms.txt (with the canonical-names stanza), sitemap, api-catalog, MCP card, Link header |
| `@junejs/core/mcp` | the Web-standard MCP endpoint (`mcpHandler`) |
| `@junejs/core/cache` | `cache()` / `invalidate()` + the `CacheStore` seam (memory built in) |
| `@junejs/core/instrumentation` | request tracing; the host installs the async-context provider |

Host-coupled concerns (fs config loader, content pipeline, dev server,
build/deploy, data layer) live in later layers and import *from* here — never
the other way around.
