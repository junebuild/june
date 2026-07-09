# agent-edge — a durable agent on Cloudflare (Workers + Durable Objects)

A deployable example of June's durable agent runtime on the **edge**: one Durable
Object per session, the durable loop committing to the DO's synchronous
`ctx.storage.sql`. It uses the real `@junejs/*` packages — the same
`AgentDurableObject` + `durableAgentSurface` the framework build will eventually
generate for you.

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

- `worker.ts` — exports `JuneAgentDO` (the DO shell → `AgentDurableObject`) and a
  fetch handler that routes `POST /message` to the session's DO
  (`durableAgentSurface`). A `create_order` `defineAction` is the agent's tool.
- `wrangler.jsonc` — the `AGENT` Durable Object binding + the `new_sqlite_classes`
  migration (SQLite-backed DO).

Note: this hand-written worker is the current edge pattern. Auto-generating it
from an `agent/` directory during `june build` (so you write zero worker glue, as
on native) is the remaining build-integration step.
