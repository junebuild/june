# junecore

The agent-native React framework. This package is the **pure, host-free
contract layer** — the most stable artifacts of the design, with zero `node:*`
or `Bun.*` (enforced by `test/purity.test.ts`).

| Subpath | What |
| --- | --- |
| `junecore/route` | `route()` + content-negotiated projections (view/json/agent/md) |
| `junecore/config` | config schema + pure resolvers (`defineJune`, `resolveAgent`, speculation rules) |
| `junecore/document` | the shared HTML shell — one document drives dev + built worker (charset lives here) |
| `junecore/agent` | the unified action registry: `defineAction`, `manifest`, `invokeAction` |
| `junecore/discovery` | llms.txt (with the canonical-names stanza), sitemap, api-catalog, MCP card, Link header |
| `junecore/mcp` | the Web-standard MCP endpoint (`mcpHandler`) |
| `junecore/cache` | `cache()` / `invalidate()` + the `CacheStore` seam (memory built in) |
| `junecore/instrumentation` | request tracing; the host installs the async-context provider |

Host-coupled concerns (fs config loader, content pipeline, dev server,
build/deploy, data layer) live in later layers and import *from* here — never
the other way around.
