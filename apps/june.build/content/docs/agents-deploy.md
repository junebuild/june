---
title: "Run & deploy: from an in-process runtime to one Durable Object per session"
nav: "Run & deploy"
description: The same agent/ directory runs on an in-process SQLite runtime in dev and compiles into a Durable Object class on Cloudflare Workers, one object per session.
date: 2026-09-27
section: Agents
order: "16.5"
sources: [packages/june/src/agent-native.ts, packages/june/src/app.ts, packages/core/src/config.ts, packages/june/src/agent-compile.ts, packages/cli/src/cli.ts, packages/june/src/build.ts, packages/june/src/adapter.ts, packages/june/src/deploy.ts, packages/june/src/agent-durable.ts, packages/june/src/worker.ts, packages/june/src/core-version.ts, packages/core/src/agent-models.ts, packages/core/src/channels.ts, examples/agent-edge, examples/slack-agent]
---
## The shape

| stage | what runs the turn | where state lives |
| --- | --- | --- |
| `june dev` | `NativeRuntime`, in process | SQLite (`bun:sqlite` under Bun, `node:sqlite` under Node) |
| `june gen` | — | compiles `agent/` into `_agent.gen.ts` |
| `june build` | emits a `JuneAgentDO` class + the `AGENT` binding | — |
| Workers | `AgentDurableObject`, one per session | the object's own `ctx.storage.sql` |

The turn engine is the same in every row. Only the store and the transport
change.

## Dev: auto-mount

When `agent.runtime.enabled` is on (the default) and `app/agent/` exists, the dev
server:

1. discovers the directory (`discoverAgent`),
2. builds a model with `anthropic({ model })` from `agent.ts`, which reads
   `ANTHROPIC_API_KEY` from the environment,
3. creates the runtime for `agent.runtime.backend` (`"durable"` falls back to
   `"native"`, since dev has no Durable Object),
4. mounts the chat endpoint (`POST agent.runtime.chat.path`, default `/message`)
   and, when `agent.runtime.channels` is on, the directory's channels,
5. runs one-shot channels (`start`) once.

```bash
curl -sX POST localhost:3000/message \
  -H 'content-type: application/json' \
  -d '{"message":"order 3 widgets","session":"s1"}'
# → {"text":"..."}
```

The native chat endpoint always answers with JSON `{ text }`. Live streaming in
dev goes through a channel's `ctx.runStream`.

The auto-mount opens the native runtime with no file path, so its SQLite is
`:memory:`. Turns are durable while the process runs and gone after a restart.
For a store that survives restarts, mount the runtime yourself.

## Dev: mounting it yourself

```ts
import { anthropic } from "@junejs/core/agent-models";
import { discoverAgent } from "@junejs/server/agent-discover";
import { createNativeRuntime, mountAgent, toAgentDef } from "@junejs/server/agent-native";

const agent = await discoverAgent("./app/agent");
const runtime = await createNativeRuntime(
  { [agent.name]: toAgentDef(agent, anthropic({ model: agent.model })) },
  "./agent.sqlite",        // default ":memory:"
  { maxSessions: 1000 },   // the default
);
const mounted = mountAgent(agent, runtime, { chatPath: "/message" });
await mounted.startAll();

Bun.serve({ fetch: async (req) => (await mounted.surface(req)) ?? new Response("not found", { status: 404 }) });
```

- **`toAgentDef(agent, model)`** takes the tools (channel tools and `read_skill`
  included), the system prompt, and the per-surface policies from the one
  definition. `mountAgent` warns when the runtime's tools differ from the
  definition's.
- **`mountAgent`** returns `surface` (chat endpoint plus channels), `fetch`
  (channels only), `startAll`, and the `ctx` channels drive turns through: `run`,
  `runDetached`, `runStream`, `resumeStream`, `resetSession`. It has no
  `runDelivered` / `resumeDelivered`, because those exist to escape the edge
  `waitUntil` limit and a native host doesn't have one. Channels fall back to the
  streaming variants.
- **`createAgentRuntime(agents, { backend, path, maxSessions })`** picks
  `"native"` (the default) or `"memory"`, and throws for `"durable"`.
- **`runtime.close()`** shuts an in-process runtime down: it cancels pending
  announcement retries, drops the actors, and closes the SQLite database
  `createNativeRuntime` opened (a database you passed to `new NativeRuntime`
  stays open). Call it before discarding a runtime in a process that keeps
  running, such as a test suite. Otherwise a retry timer fires later against a
  closed or deleted database.

### Session actors and eviction

`NativeRuntime` keeps one `AgentSession` actor per `(agent, session)` in an LRU,
capped by **`maxSessions` (default 1000)**. It is a soft cap. When a new actor is
needed and the cap is reached, the least recently used **idle** actors are
dropped. Idle means `session.idle()` is true (no turn running or queued, no reset
pending) and no live subscriber is attached. Busy actors are never dropped, so
the count can go over the cap while they run. A dropped actor's state is all in
SQLite, and the next `session()` call rebuilds it.

`maxSessions` must be an integer ≥ 1, or `Infinity` for no cap. Anything else
(`0`, `NaN`, `1.5`) throws a `RangeError` at construction.

Because actors can be evicted, call `runtime.session()` where you use it. Don't
hold an `AgentSession` across an `await` and start turns on it later: if it was
evicted in between, a fresh actor for the same session would run turns in
parallel with it.

The `memory` backend (`MemoryRuntime`) never evicts, since the actor is the
state, so it grows with every session. Use it for dev and tests, not a
long-running host.

### Version guard

The server↔core runtime contract is versioned, now at
`RUNTIME_API_VERSION = 6` (the latest bump: `AgentSession.note()` and the `note`
message role, which the Durable Object's `/note` route calls). `NativeRuntime`,
`MemoryRuntime`, and `AgentDurableObject` check it at construction. If a package manager nests a
second, older `@junejs/core` under `@junejs/server`, you get an error naming both
versions at startup, not a failure in the middle of a turn. Dedupe to one core.

## Build: `june gen`

Workers has no filesystem, so native discovery can't run there. `june gen`
compiles the agent directory into `_agent.gen.ts` inside it. The output uses
static imports for `tools/`, `channels/`, and `connections/`, and inlines the
markdown (instructions, variants, skills) as strings:

```bash
june gen           # writes app/agent/_agent.gen.ts (or ./agent/ in a wrangler-first worker)
june gen --check   # writes nothing; exits 1 if the file is stale (the CI gate)
```

It looks for `app/<dir>` first, then `<root>/<dir>`, where `<dir>` is
`agent.runtime.dir`. Files starting with `_` are skipped, so the generated
module never scans itself. A legacy `channels/<source>.md` still compiles, with a
deprecation warning pointing at `instructions.<source>.md`.

## Build: `june build`

On a target with Durable Objects (the default `workers()` adapter), `june build`
compiles `app/agent/` the same way and wires it into the generated worker entry.
Other targets skip the agent with a warning.

Before bundling, it checks that the app can bundle the SDK. It walks up from the
app root looking for `node_modules/@anthropic-ai/sdk`, and fails the build with
the fix if the SDK isn't there:

```text
app/agent/ mounts a durable agent whose model is Claude — add the SDK to the app
so it bundles for workerd: bun add @anthropic-ai/sdk
```

The generated entry assembles the module with `assembleDurable` and exports the
Durable Object class:

```ts
// dist/worker.js (generated — shown as source)
export class JuneAgentDO extends DurableObject {
  #agent = new AgentDurableObject(this.ctx, {
    ...__agentDef, // tools, instructions, surface policies, channels, connections
    model: anthropic({ model: __agentModule.config.model, client: new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }) }),
    env: this.env,
    // + resources / services when june.config declares them
  });
  fetch(req) { return this.#agent.fetch(req); }
  // delivers input announcements left undelivered — a failed hook's retry, or the watchdog
  alarm() { return this.#agent.alarm(); }
}
```

It also puts the agent's name and channels on the worker manifest and adds the
binding to the emitted `dist/wrangler.jsonc`:

```jsonc
"compatibility_flags": ["nodejs_compat"],
"durable_objects": { "bindings": [{ "name": "AGENT", "class_name": "JuneAgentDO" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["JuneAgentDO"] }]
```

If the app has its own `wrangler.toml` or `wrangler.jsonc`, June doesn't touch
it. The build warns and prints the snippet to add when that config doesn't bind
`JuneAgentDO` under `AGENT`. A class named only in `migrations`, a binding under
another name, or a commented-out table all trigger the warning.

## On Workers

### One Durable Object per session

The worker addresses each session's object with
`idFromName("<agent>:<session>")` and sends the session key in the
`x-june-session` header (exported as `SESSION_HEADER`). A Durable Object can't
read its own name, so it saves the first key it's given and rejects a mismatched
one with 409. The store needs no `session_id` column. The object is the session:
`agent_messages`, `agent_steps`, and `agent_meta` in its SQLite, with
transactions via `ctx.storage.transactionSync`, so the exactly-once contract is
the same as native — including its scope: only writes through `ctx.storage.sql`
join the step's transaction.

The object's HTTP surface:

| route | does |
| --- | --- |
| `POST /turn` | start a turn and stream its `TurnEvent`s as SSE (`:hb` heartbeat every 20 s, `cache-control: no-store`) |
| `POST /turn?detach=1` | 202 once accepted; the turn runs with no consumer |
| `POST /turn?deliver=1` | 202 once accepted; the object renders the reply through the source channel's `deliver()` |
| `POST /turn?replace=1` | cancel unfinished turns first (combines with the above) |
| `POST /resume` | apply a human's answer and stream the continuation (403 unauthorized, 409 stale); `?deliver=1` renders through `deliverResume()` |
| `POST /reset` | archive the history; returns `{ previousSession, generation }` |
| `POST /note` | append an attributed note to the history (`{ by, kind, text }` → `{ noteId }`, 400 on a missing field) |
| `GET /transcript` | the folded transcript |

`POST /turn` also accepts `ifSuspended` in its body. The default `"reject"` 409s
a turn started against a suspended session; `"queue"` holds it and runs it once
the park resolves, returning `{ turnId, queued: true }` with a 202. Because a held
turn's reply arrives later, `"queue"` requires `?deliver=1` or `?detach=1` — a
streaming caller asking to be held is a 400.

### The worker side

Two helpers from `@junejs/server/agent-durable` route to those objects:

- **`durableAgentSurface(getNamespace, { agentName, chatPath })`** is the chat
  endpoint. The body is `{ message, session? }`. It pipes the SSE through when
  the request sends `Accept: text/event-stream` and returns `{ text }` otherwise.
  A session key that can't go in a header gets a 400.
- **`durableChannelSurface(getNamespace, { agentName, channels, env, services?,
  waitUntil? })`** mounts the channel webhooks. It resolves `(env) => Channel`
  factories with the worker's `env` and gives channels a `ctx` whose `run`,
  `runStream`, `runDetached`, `runDelivered`, `resumeStream`, `resumeDelivered`,
  and `resetSession` all call the session's Durable Object. The `services` bag is
  memoized per `(env, agentName)`.

In a built June app you don't write either. The generated worker mounts both
when the manifest names an agent, reading `env.AGENT` from **the current
request's** env and passing that request's `waitUntil`. A module-level "current
request" would give a webhook another concurrent request's env and secrets.

### Escaping the `waitUntil` limit

A webhook ACKs fast and renders the reply in the background. On Workers that
background work lives in `ctx.waitUntil`, which the runtime cancels shortly after
the response ends. A long multi-round turn would stop mid-reply with no error.

The delivered variants move the rendering into the Durable Object, which stays
alive while it has pending work:

- `ctx.runDelivered(text, opts)` sends `/turn?deliver=1`. The object runs the
  turn **and** renders it through the channel's own `deliver()`.
- `ctx.resumeDelivered(opts)` sends `/resume?deliver=1` and renders the
  continuation into the Approve / Deny message through `deliverResume()`.

Both need the channel wired into the object (`DoAgentDef.channels`), which the
generated entry does. When the object can't deliver, it refuses with 501
**before** starting the turn or applying the answer. The worker turns that into
`DeliverUnsupportedError`, the one error a channel may answer by rendering
itself, because the turn is guaranteed not to be running. `slackChannel` tries
`runDelivered` first when `stream: true`, and always tries `resumeDelivered`
first for button clicks.

### Resources, services, failures

A Durable Object is a separate isolate, so the worker's request scope doesn't
reach it. `DoAgentDef.resources` and `services` are built from the object's own
env and installed around every turn, so a tool reads ambient `db` and
`currentServices()` the same way a route loader does. The generated entry passes
the ones `june.config.ts` declares. The scope uses `node:async_hooks`, which
needs the `nodejs_compat` flag. The generated config sets it, and a hand-written one
should too. Without it the object has no request scope, and the two ambient APIs
fail differently: `db` / `kv` / `blob` **throw** ("used outside a request scope"),
while `currentServices()` quietly returns `undefined` — so a missing service shows
up later, as an undefined value in your own code.

Turn failures go to `console.error` with the step and cause chain.
`DoAgentDef.onTurnError` replaces that with your own telemetry. If the hook throws,
the default log still runs.

## The Anthropic SDK

`@anthropic-ai/sdk` is an **optional peer** of both `@junejs/core` and
`@junejs/server`. `anthropic()` imports it lazily with a specifier bundlers can't
see, which keeps core installable without it. The trade-off is that a bundled app
(a Worker, `bun build --compile`) can't find the SDK at runtime. Bundled apps
import it themselves and inject the client:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@junejs/core/agent-models";

const model = anthropic({ model: "claude-opus-4-8", client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) });
```

`june build` does this in the generated entry. If the lazy import fails, or the
module has no default export that can be called with `new`, `anthropic()` throws
one error naming both fixes (install the SDK, or inject `client`) and keeps the
original error as `cause`.

## Secrets and env

- **`ANTHROPIC_API_KEY`**: from `process.env` natively. On Workers the generated
  Durable Object reads it from `this.env`, so set it as a Worker secret. If it's
  missing, the SDK's own construction error shows up on the first agent request.
- **Channel secrets** (Slack signing secret, bot token, Crisp keys) exist only in
  `env` on Workers, never at module scope. Write the channel as an
  `(env) => Channel` factory. The worker resolves it for the webhook and the
  Durable Object resolves it again for the channel's tools:

```ts
// app/agent/channels/crisp.ts
import { crispChannel } from "@junejs/core/channels";

export default (env: { CRISP_SIGNATURE_SECRET?: string; CRISP_IDENTIFIER?: string; CRISP_KEY?: string }) =>
  crispChannel({
    signingSecret: env.CRISP_SIGNATURE_SECRET ?? "",
    identifier: env.CRISP_IDENTIFIER ?? "",
    key: env.CRISP_KEY ?? "",
  });
```

## Deploy walkthrough

**A June app** (`app/agent/` inside the app):

```bash
bun add @anthropic-ai/sdk        # the build preflight requires it
june build                       # dist/worker.js + dist/wrangler.jsonc with the AGENT binding
june deploy                      # build → wrangler deploy
```

Then set `ANTHROPIC_API_KEY`, plus any channel secrets, as secrets on the
deployed worker.

**A wrangler-first worker** (no June app, as in `examples/agent-edge`): keep
`agent/` next to `worker.ts`, run `june gen`, and write the shell `june build`
would have generated:

```ts
// worker.ts
import { DurableObject } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { AgentDurableObject, durableAgentSurface, durableChannelSurface, type DurableObjectNamespace } from "@junejs/server/agent-durable";
import { anthropic } from "@junejs/core/agent-models";
import { assembleDurable } from "@junejs/core/agent-config";
import agentModule from "./agent/_agent.gen";

type Env = { AGENT: DurableObjectNamespace; ANTHROPIC_API_KEY?: string };
const def = assembleDurable(agentModule);

export class JuneAgentDO extends DurableObject<Env> {
  #agent = new AgentDurableObject(this.ctx, {
    ...def,
    model: anthropic({ model: agentModule.config.model, client: new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }) }),
    env: this.env,
  });
  fetch(req: Request) { return this.#agent.fetch(req); }
  // required for input-announcement delivery (the retry and watchdog alarm); june build's shell does this too
  alarm() { return this.#agent.alarm(); }
}

export default {
  fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const chat = durableAgentSurface(() => env.AGENT, { agentName: def.name, chatPath: "/message" });
    const channels = durableChannelSurface(() => env.AGENT, { agentName: def.name, channels: def.channels, env, waitUntil: ctx.waitUntil.bind(ctx) });
    return chat(req).then((r) => r ?? channels(req)).then((r) => r ?? new Response("not found", { status: 404 }));
  },
};
```

```jsonc
// wrangler.jsonc
{
  "name": "june-agent-edge",
  "main": "worker.ts",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "AGENT", "class_name": "JuneAgentDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["JuneAgentDO"] }]
}
```

```bash
bunx wrangler dev                        # local, DO SQLite included
wrangler secret put ANTHROPIC_API_KEY    # once
bunx wrangler deploy
```

`examples/agent-edge` swaps in a scripted model when no key is set, so
`wrangler dev` runs the whole durable loop offline. `examples/slack-agent` wires
`slackChannel` the same way, with the Events API and Interactivity request URLs
both pointing at `/channels/slack`.

## Why it matters

You don't port an agent to production. You compile it. The directory you ran in
dev becomes a Durable Object class with the same engine, the same checkpoints,
and the same channel code, and each conversation gets its own single-threaded
object with its own SQLite. The things that differ between dev and Workers
(where secrets live, how long a request may run, how the SDK is bundled) are
handled by the build or reported by it.
