---
"@junejs/server": patch
---

`june build` auto-mounts the durable agent — zero hand-written worker (#139).

A June app with an `app/agent/` directory now builds to an edge worker whose agent surface needs no glue at all. The build compiles the directory into `_agent.gen.ts` (the same freeze `june gen` runs), imports it from the generated entry, sets `WorkerManifest.agentName` — the declared-but-never-fed input that activates `createWorker`'s existing chat routing (`durableAgentSurface` → `env.AGENT`) — and exports a generated `JuneAgentDO` class: one Durable Object per session, `assembleDurable(agentModule)` as its definition (adapted tools + `read_skill`, the assembled system prompt, channel factories resolved with the DO's own env), the Anthropic model keyed by the `ANTHROPIC_API_KEY` secret, and the app's declared services factory threaded through when present. `buildManifest` sets `agentName` too, so in-process consumers (prerender, the parity test) see the same manifest shape — inert without an `env.AGENT` binding.

The `workers()` adapter emits the binding: `durable_objects.bindings` (`AGENT` → `JuneAgentDO`) plus the `new_sqlite_classes` migration (the DO's `ctx.storage.sql` is the durable loop's synchronous store). An app that owns its wrangler config keeps winning — but when a durable agent was built and the config doesn't name the class, the build warns with the exact stanza to add instead of silently shipping a worker whose chat endpoint 404s. Adapter capabilities grow `durableObjects` (workers() only); on targets without it (vercel/deno/static) an agent directory produces a clear build notice, not a broken deploy. `cloudflare:workers` joins the bundle-external set as a workerd runtime module.

An app without an `agent/` directory emits a byte-identical entry — the parity guarantee holds. Remaining in #139: edge channel-webhook routing through the built worker (needs the `waitUntil` seam threaded into `createWorker.fetch`), and lazy connection wiring in the DO.
