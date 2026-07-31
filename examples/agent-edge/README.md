# agent-edge — a durable agent on Cloudflare (Workers + Durable Objects)

A deployable example of June's durable agent runtime on the **edge**: one Durable
Object per session, the durable loop committing to the DO's synchronous
`ctx.storage.sql`. The agent DEFINITION lives in the `agent/` directory —
`agent.ts`, `instructions.md`, `tools/`, `channels/` — the same convention
native discovery mounts in dev; `june gen` compiles it into
`agent/_agent.gen.ts` (static imports, prose inlined) so it bundles for
workerd, where fs discovery can't run.

> Editor types: `cloudflare:workers` types come from `@cloudflare/workers-types`
> — add it locally (`bun add -d @cloudflare/workers-types`) for editor
> autocomplete. It's not a repo dependency; `wrangler` (via `bunx`) builds the
> worker regardless.

## Run it locally (no API key needed)

```bash
bun install
bun run dev          # bunx wrangler dev → http://localhost:8787

curl -sX POST localhost:8787/message -d '{"message":"order 3 widgets","session":"s1"}'
# → {"text":"Done — order placed."}
```

Offline by design: with no `ANTHROPIC_API_KEY`, the agent runs a **scripted
model** (deterministic, zero network) — June's Model seam is pluggable, so you
exercise the whole durable loop + DO storage with no key and no HTTP mocking
(that's why you don't need MSW here — you swap the model, not intercept fetch).

Durability is real even in dev: the turn commits to the DO's SQLite. Send the
same `session` again and the transcript persists across the DO hibernating.

## Deploy (real Claude)

```bash
wrangler secret put ANTHROPIC_API_KEY   # once
bun run deploy                          # wrangler deploy
```

With the key set, the DO builds `anthropic({ model: "claude-opus-4-8", … })`
instead of the scripted model — same loop, real tool-calling.

## What's here

- `agent/` — the agent definition, as a directory: `agent.ts` (config),
  `instructions.md`, `tools/create_order.ts` (a `defineAction`),
  `channels/crisp.ts` (a `(env) => Channel` factory). Edit these, then
  regenerate.
- `agent/_agent.gen.ts` — the compiled module (`june gen`; checked in). Static
  imports + inlined prose; skills would mount here too (`read_skill` is added
  automatically when `skills/*.md` exist).
- `worker.ts` — the app's genuine remainder: the `JuneAgentDO` shell wiring
  `assembleDurable(agentModule)` + the model to `AgentDurableObject`, and the
  fetch handler routing `POST /message` (`durableAgentSurface`) and
  `POST /channels/crisp` (`durableChannelSurface`).
- `wrangler.jsonc` — the `AGENT` Durable Object binding + the `new_sqlite_classes`
  migration (SQLite-backed DO).

After editing anything under `agent/`, run `june gen` (or
`bunx june gen`) to refresh `_agent.gen.ts`; CI can enforce freshness with
`june gen --check`.

Note: a full June app doesn't need any of this worker glue — `june build`
compiles `app/agent/`, exports the DO class from its generated entry, and
emits the wrangler bindings automatically. This example is the
**wrangler-first** pattern: a standalone worker (no June app around it)
consuming the compiled module directly.
