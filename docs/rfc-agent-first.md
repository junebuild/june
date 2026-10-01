# RFC: Agent-first June

Status: **proposal / draft** · Stage: v0 (no back-compat constraint) · Scope: positioning
(README, june.build home and docs order), the agent harness in `@junejs/core`
(`agent-runtime.ts`, `agent-models.ts`, `agent-config.ts`), the `agent/` directory convention
(`agent-discover.ts`, `agent-compile.ts`), the durable hosts (`agent-durable.ts`,
`agent-native.ts`), `create-june` templates, and the `june` CLI.

> **Internal design rationale.** This RFC names an external framework (eve) for traceability
> of *why* we chose what we chose. Outward-facing copy derived from it must stay
> competitor-neutral.

## Summary

June started as **a React framework** that also served agents. The work of the last months —
durable turns, channels, connections, HITL, supervise, notes, the inbox/email RFCs — has
shifted its center of gravity: the hard, differentiating problems are now agent problems, and
React is one of several surfaces they render to.

This RFC makes that explicit:

1. **Positioning.** June becomes *the framework for agents that live inside real apps*. React
   (RSC, islands, the App Router) stays, but is presented as the renderer for the **human
   surface**, not as the identity of the framework.
2. **Harness completeness.** The agent runtime gains what a long-lived, production agent needs
   and June lacks today: context compaction, steering, multi-provider models, schedules,
   memory, declared subagents, evals, hooks, and a sandbox.
3. **Keep the moat.** None of this replaces what June does that a backend-only agent framework
   cannot: one `defineAction` that can serve as UI action, MCP tool, HTTP endpoint and agent
   tool from a single definition (§3 lists the conditions); an app whose pages and actions are
   agent-readable; durable sessions on the edge as well as natively.

The guiding sentence: **learn eve's harness, bet on what eve does not have.**

## 1. Motivation

The README's first line is "The React framework for building agents into real apps." The noun
is *React framework*. That framing made sense when the novel parts were RSC-without-a-router,
`.md`/`.json` projections and islands. It no longer matches where the engineering effort and
the user value are:

- Most recent RFCs are agent RFCs: `rfc-turn-as-live-process.md`, `rfc-email.md`,
  `rfc-tui.md`.
- The agent layer is now the largest subsystem in core (`agent-runtime.ts`, `channels.ts`,
  `agent-config.ts`, `connections.ts`, `supervise.ts` — roughly 5k lines) plus the durable
  hosts in `@junejs/server`.
- A developer evaluating June for an agent today compares it against agent frameworks, not
  against React frameworks — and on that comparison June is missing table-stakes harness
  features (§3) while under-selling its genuine advantages (§4).

Leading with React also has a cost: it implies June is for people who are building a website
first. Many agent builders start from the agent (a Slack bot, an email correspondent, an
ops assistant) and only later want a UI. June should welcome them at the front door.

## 2. Prior art: eve

eve (Vercel, Apache-2.0, beta) is "a filesystem-first framework for building durable backend AI
agents". Read in full from eve.dev's docs corpus on 2026-10-01. What it gets right:

| eve concept | what it is |
| --- | --- |
| Filesystem slots | `agent/` with `agent.ts`, `instructions.md`, `tools/`, `skills/`, `channels/`, `connections/`, `subagents/`, `schedules/`, `memory/`, `sandbox/`, `hooks/`, `extensions/`, `instrumentation/`; names derive from paths; a default occupies the same slot an authored file would, so authoring replaces it and `disableTool()` removes it |
| Execution model | session → turn → step; each session is one durable workflow (Workflow SDK; Vercel Workflow on Vercel, a local or Postgres "world" self-hosted); parked work holds no compute; idle sessions hand off to the newest deployment |
| Default harness | compaction at a token threshold (trims oversized old tool results first, then summarizes into a checkpoint that is updated, not stacked); manual `compact()` / `clear()` |
| Steering | `turnPolicy: "steer"` (interrupt pending generation, apply the correction in the same turn) or `"queue"` (fold into the next turn) |
| Sandbox | one per session, rooted at `/workspace`; `bash` / `read_file` / `write_file` / `glob` / `grep` tools; pluggable backends (Vercel, Docker, microsandbox, just-bash); credentials stay app-side and are brokered |
| Memory | provider-backed slots with a recall / capture / tools contract, integrated with compaction |
| Subagents | declared under `agent/subagents/<name>/`, isolated (own context, session, sandbox, tools); remote agents over HTTP |
| Evals | `evals/` beside `agent/`, cases + assertions + judge, `eve eval` |
| Ops | OpenTelemetry, hooks on stream events, a TUI, ACP, a large channel catalog |

Where it is coupled, and where June differs by design:

- **The app is a separate service.** A browser UI is a peer app (`apps/web/`) that talks to
  the agent's `/eve/v1` routes via `useEveAgent`. Tools are agent-only; the UI does not share
  them.
- **Durability rides a workflow platform.** It is portable in principle (worlds), but the
  first-class path is Vercel Workflow + Vercel Sandbox.
- **No outward agent surface for the app itself.** Each deployment exposes its own agent API;
  it is not an MCP server for the app's data, and has no `.md` / `.json` projections.

`rfc-turn-as-live-process.md` §1 already observed that peers "bake liveness + HITL + proactive
delivery into a heavy, platform-coupled channel layer" and chose portable primitives instead.
This RFC extends the same stance from the turn to the whole harness.

## 3. Current architecture — what exists, what is missing

Verified against `main` at 8958705 on 2026-10-01.

| capability | June today | evidence |
| --- | --- | --- |
| `agent/` directory convention | ✅ `agent.ts`, `instructions(.<source>).md`, `tools/`, `skills/`, `channels/`, `connections/`; native discovery and `june gen` share one assembly | `agent-discover.ts`, `agent-compile.ts` |
| Durable turns | ✅ log-replay + step checkpoints; one Durable Object per session on Workers, SQLite in dev; sync tools exactly-once through `ctx.store` | `agent-runtime.ts`, `agent-durable.ts` |
| Streaming | ✅ `Model` returns `AsyncIterable<ModelDelta>`; `TurnEvent` stream; `observeTurnEvents` | `agent-runtime.ts:139`, `turn-events.ts` |
| HITL | ✅ `ctx.requestInput`, answerers, `onInputAnnouncement`, notes, supervise | `agent-runtime.ts`, `supervise.ts` |
| Cancellation | ✅ `session.cancel(turnId)` | `agent-runtime.ts:1182` |
| Proactive turns | ✅ `ProactiveTrigger` + channel `deliver` | `agent-config.ts`, `channels.ts` |
| Subagents | ⚠️ native proof of concept only: `subagent: true` is a marker; the tool body itself opens a child with `ctx.runtime.session(...)`. The Durable Object host rejects every child-session request (cross-DO wiring not implemented). No directory slot, no isolation contract, no docs | `agent-runtime.ts:184,221`, `agent-durable.ts` (`crossDoUnsupported`), `core/test/agent-runtime.test.ts` |
| Schedules | ❌ no primitive; a cron is only mentioned as a possible *caller* of a proactive turn | `agent-runtime.ts:1156` |
| Context compaction | ❌ none | no match for `compact` in `packages/` sources |
| Steering / queue policy | ❌ none (a new message while a turn runs is chained behind it) | `AgentSession.start` chain |
| Multi-provider models | ⚠️ the `Model` seam is provider-agnostic, but only `anthropic()` ships | `agent-models.ts` |
| Cross-session memory | ❌ none | — |
| Sandbox + shell/file tools | ❌ none | — |
| Evals | ❌ none (the model-eval replay method exists only as practice, not a product) | — |
| Observability | ⚠️ `instrumentation.ts` traces; no OpenTelemetry export | `instrumentation.ts` |
| One definition, every surface | ✅ with conditions: a described `defineAction` is a UI server action and an `/mcp` tool; it is also `POST /api/<id>` only when its id round-trips as one URL path segment (`isRoutableActionId`); it is an agent tool only when exported from `agent/tools/` (or otherwise included in the agent assembly). One authorization path, `requiresPrincipal` | `agent.ts`, `mcp.ts`, `api.ts:54-81` |
| App as an agent surface | ✅ three separate mechanisms: page routes derive `.md` / `.json` projections unless a route disables them (`json: false`, `md: false`); `llms.txt`, sitemap and the API catalog derive from the route list plus the action registry; the MCP server lists tools from the action registry, not the route graph (2026-07-28 + 2025 fallback). Resource `route.*` files are arbitrary `Response` handlers with no projections | `route.ts:91-98`, `discovery.ts`, `mcp.ts`, `app.ts` |
| React-free agent runtime | ✅ at module level: the agent modules import no React; `react` is an optional peer of `@junejs/core`; `examples/agent-edge` is a standalone Worker | `packages/core/package.json` |

Read as a whole: **the durable core is ahead; the harness around it is behind.**

## 4. Positioning — what changes, what stays

### 4.1 The new line

> **June — the framework for agents that live inside real apps.**
> One definition serves your UI, your agent's tools, and every outside agent.

Supporting claims, in order of how hard they are to copy:

1. **One capability definition.** One `defineAction` serves as the UI's server action and the
   app's MCP tool, becomes the agent's tool when the agent assembles it, and is an HTTP
   endpoint when its id is URL-routable — all behind one authorization gate. Nothing drifts
   because nothing is duplicated. A backend-only agent framework structurally cannot offer
   this: its tools and the app's endpoints are two codebases.
2. **The app is an agent surface.** Page routes answer in HTML, `.md` and `.json` by default;
   the route list and the action registry derive `llms.txt` and the API catalog; the action
   registry backs the MCP server. Your *own* agent and *other people's* agents read the same
   pages and call the same actions.
3. **Durability without a workflow service.** Sessions run on June's own log-replay engine:
   on Workers each session is a Durable Object (no queue to provision, a parked session holds
   no compute); on native hosts sessions persist in local SQLite inside the app process, where
   a parked session costs storage but no extra service.
4. **Operators are first-class.** Supervise, notes, answerers, the inbox contract — humans
   working alongside the agent are designed in, not bolted on.

### 4.2 What React becomes

React is **the renderer for the human surface**: RSC, islands, layouts, the App Router. Nothing
is removed. What changes:

- README and june.build home lead with agents; RSC, islands, styling and navigation move under
  a "The human surface" heading.
- The docs nav puts **Agents** first, then **Actions & MCP**, then **The human surface**.
- `stability.md` keeps tracking both; the agent layer graduates as §6–§8 land.

### 4.3 Two front doors

- **App-first** (today): `npm create june` → an app with an optional `agent/`.
- **Agent-first** (new): `npm create june -- --template agent` → `agent/` + `june.config.ts`,
  no `app/` pages, no React dependency installed. Adding `app/` later turns it into a full
  June app with no migration, because both doors build the same assembly.

## 5. Design principles

1. **Portable primitives, platform adapters.** Every new capability is a contract in
   `@junejs/core` (zero `node:*`, as enforced today) with host adapters in `@junejs/server`.
   Workers + Durable Objects and native (Bun/Node + SQLite) are both first-class.
2. **The directory is the manifest.** Every capability gets a slot under `agent/`; a framework
   default occupies the same slot an authored file would, so authoring a file replaces it and
   an explicit export disables it. One assembly function for native discovery and `june gen`.
3. **Replay-safe by construction.** Each new feature states its delivery guarantee
   (exactly-once through `ctx.store`, at-least-once otherwise) and where it checkpoints.
4. **Credentials never reach model-controlled compute.** This already holds for connections;
   the sandbox (§8) must preserve it.
5. **Reuse the app.** Where an agent needs storage (memory, eval runs, schedules), the default
   backend is the app's own `db`/`kv`, not a new service.

## 6. Harness

### 6.1 Context compaction

A long session must not overflow the model's context window.

- **Trigger:** before each model call, estimate input tokens (the last provider-reported input
  count plus an estimate of messages appended since) against `compaction.thresholdPercent`
  (default `0.85`) of the model's context window.
- **Stage 1 — trim:** shorten oversized tool results in older history (keep head and tail,
  record the elision). If that frees enough, stop.
- **Stage 2 — summarize:** replace older turns with a single **checkpoint** message that
  separates completed work and decisions from remaining work, and keeps the constraints,
  preferences and references needed to continue. A later compaction passes the previous
  checkpoint in *separately* and replaces it; checkpoints never stack.
- **Durability:** compaction is a step. Its result is checkpointed like a model reply, so replay
  never re-summarizes. The `messages` log keeps the full history; compaction writes a
  `{ role: "checkpoint" }` record that the model-message builder starts from. The transcript
  (operators, inbox) still shows everything.
- **Notes and parked input** are preserved verbatim, never summarized away.
- **Manual control:** `session.compact()` and `session.clear()` (clear keeps identity, tools,
  durable state and the store; drops model-visible history). Both are queued behind a running
  turn and emit `context.compacted` / `context.cleared` TurnEvents.

```ts
// app/agent/agent.ts
export default {
  name: "ops",
  model: "anthropic/claude-opus-5-5",
  compaction: { thresholdPercent: 0.8, model: "anthropic/claude-haiku-4-5" },
};
```

### 6.2 Steering and queue policy

Today a message that arrives while a turn runs is chained behind it. On chat surfaces (Slack,
the inbox) people correct themselves mid-turn: "actually, the other order."

- `turnPolicy: "queue"` (today's behavior, made explicit): the message starts the next turn;
  adjacent queued messages may fold into one turn, preserving order.
- `turnPolicy: "steer"`: if the running turn has not started emitting assistant text, abort the
  pending model call, append the new message, and continue **the same turn**. An executing tool
  always finishes and commits first. Once assistant text has streamed, steering applies at the
  next step boundary.
- Default per channel: `steer` for conversational channels, `queue` for HTTP and email.
- Pure input answers (`session.resume`) never steer.
- Durability: the steer is recorded in the log before the abort, so replay reproduces it.
- New TurnEvent: `turn.steered`.

### 6.3 Models: multi-provider

The `Model` seam is already provider-agnostic; only adapters are missing.

- Model ids become `provider/model` strings (`anthropic/claude-opus-5-5`,
  `openai/<id>`, `google/<id>`), resolved by a registry of adapters. A bare id keeps meaning
  Anthropic for v0 convenience.
- Ship `openaiCompatible()` (covers OpenAI and most local servers) and `gemini()`, each an
  optional peer like `@anthropic-ai/sdk` today, each mapping its finish reasons onto
  `ModelFinish`.
- `agent.ts` may pass a function `(ctx) => modelId` for per-turn selection (tenant, surface,
  cost tier).
- The live contract suite gains one replayed agent loop per adapter (see the model-eval replay
  practice) so adapters are judged on tool-calling behavior, not just text.

## 7. Directory slots

The convention grows to:

```text
app/agent/
  agent.ts
  instructions.md, instructions.<source>.md
  tools/          (exists)
  skills/         (exists)
  channels/       (exists)
  connections/    (exists)
  subagents/<name>/   NEW — declared specialists
  schedules/          NEW — cron-driven proactive turns
  memory.ts           NEW — cross-session memory provider
  hooks/              NEW — TurnEvent subscribers
  sandbox.ts          NEW — §8
evals/                NEW — beside agent/, not inside it
```

### 7.1 `subagents/<name>/`

Turn the native proof of concept (a tool body that opens a child with
`ctx.runtime.session(...)`) into a slot that works on every host. **This slice includes
cross-host child routing**: on Workers, a child session is a sibling Durable Object reached
over DO RPC, replacing today's `crossDoUnsupported` runtime. Shipping the slot without it
would work in dev and fail on the primary edge host.

- A subagent directory uses the same convention: `agent.ts` (with a required `description`),
  optional `instructions.md`, `tools/`, `skills/`, `connections/`, nested `subagents/`.
  `channels/` and `schedules/` are root-only.
- The parent gets one tool per subagent, `delegate_<name>({ task })`, returning the child's
  final text plus a session reference.
- **Isolation:** a subagent inherits nothing implicitly — not tools, not instructions, not
  connections. It *does* inherit the turn's `principal` and `initiator`, so authorization
  stays the caller's, never widened by delegation.
- Durability: at-least-once with an idempotent child `turnId` (`agent-runtime.ts:922`) on
  native today; the sibling-DO path must derive the child's DO id and `turnId`
  deterministically from the parent's session, turn and call ids so a redelivered call reaches
  the same child turn. A child that parks for input parks the parent's tool call.
- Operators see child sessions linked from the parent's transcript.

### 7.2 `schedules/`

```ts
// app/agent/schedules/daily_digest.ts
import { defineSchedule } from "@junejs/core/agent";

export default defineSchedule({
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  target: { channel: "slack", thread: "C0123456" }, // where output is delivered
  prompt: "Summarize yesterday's open orders that need attention.",
});
```

A Markdown form is also accepted: `schedules/daily_digest.md` with `cron`, `timezone` and
`target` frontmatter; the body is the prompt.

- Each firing starts a proactive turn (`ProactiveTrigger { by: "schedule:<name>" }`) and
  delivers through the target channel's existing proactive `deliver` path.
- **Session policy:** `session: "fresh"` (default, one session per firing) or
  `session: "<stable id>"` (one long-running session, which is where compaction matters).
- **Guarantee: at-least-once per occurrence, with idempotent turns.** Each firing is a
  persisted *occurrence* `(schedule, scheduledTime)`. Its session id (for `fresh`) and turn id
  are derived deterministically from the occurrence, so redelivery after a crash between
  dispatch and bookkeeping reaches the same turn instead of starting a second one. The
  occurrence is marked done only after the turn is accepted.
- Hosts: Workers → `june build` emits Cron Triggers and routes them into the agent's DO;
  native → an in-process scheduler that, on start, catches up missed occurrences within a
  configurable window (`catchUp`, default: the latest missed occurrence only).
- Dynamic schedules (created by a tool at runtime) are a later slice on DO alarms.

### 7.3 `memory.ts`

Cross-session context, scoped to a principal or tenant.

- Contract: `recall(ctx) → records`, `capture(ctx, transcriptSlice)`, and optional
  model-facing tools (`remember`, `forget`).
- Lifecycle: recall at session start and after each compaction; capture before compaction and
  at session end. Recalled records are excluded from the summarizer and attributed in the
  prompt (like notes: information, not instructions).
- **Default provider is the app's own `db`** (a Juno table keyed by principal), so memory is
  ordinary app data: queryable, migratable, deletable on a user's request. This is a concrete
  case of "the agent lives inside the app".
- **Scoping is enforced by the framework, not trusted to the provider.** The runtime derives
  a mandatory scope key from trusted identity only (the turn's `principal`, falling back to
  the session's `initiator`; a schedule must declare a fixed scope in its definition) and
  passes providers an already-scoped handle, never a raw store. With no trusted scope, recall
  returns nothing and capture is refused (fail closed), and a `memory.*` TurnEvent records
  the skip. The default provider's table has the scope key in its primary key, so a
  cross-scope read is not expressible through it. Custom providers receive the same scope key
  and the docs state that keying on anything else is a tenant-isolation bug.

### 7.4 `hooks/`

Hooks observe; they never alter the turn. `TurnEvent` mixes two kinds of event, so hooks come
in two kinds with different guarantees:

- **Durable hooks** (`hooks/*.ts` exporting `onCommitted`) receive only the *committed*
  subset — events that correspond to a record in the session log (a committed step, a tool
  result, an input request, a note, a resolution). They are fed from a per-session outbox
  written in the same transaction as the record, and run at-least-once with the record id as
  the idempotency key. The exact subset is enumerated from the engine as part of this slice.
- **Live hooks** (`onLive`) receive every event, including live-only ones that are never
  persisted or replayed (`message.delta`, `reasoning.delta`, `turn.started`, `turn.failed`
  and others). They are best-effort: at-most-once, lost on a crash or a host restart.

This is also the attachment point for OpenTelemetry export (`@junejs/server/otel`), mapping turn →
span, step → child span, tool call → child span.

### 7.5 `evals/`

```text
evals/
  refunds.eval.ts     cases + assertions
  fixtures/
```

- A case is an input (message, or a scripted multi-turn exchange), optional seeded `db` state,
  and assertions: tool called / not called with matching input, final text matches, a
  `judge()` rubric scored by a model, or a ground-truth grader over the resulting `db` state.
- Runs the **full agent loop with the real tools** against a scratch database (the replay
  method we already use in practice); connections are stubbed at the `fetch` seam.
- `june eval [--model <id>] [--repeat n]` reports pass rate per case and variance across
  repeats, so a model or prompt change is judged on numbers.

## 8. Sandbox

The largest and last slice. Agents that analyze data or touch code need a filesystem and
processes; June has neither for the model.

- Contract `Sandbox { run, spawn, readFile, writeFile, setNetworkPolicy? }`, opened lazily per
  session by `ctx.getSandbox()`, handle checkpointed so replay resumes the same sandbox.
- Default tools `bash`, `read_file`, `write_file` occupy `tools/` slots and are replaceable or
  disableable like any authored tool. They are **off** unless `sandbox.ts` exists.
- Backends: Cloudflare Sandbox/Containers on Workers; local Docker (or a subprocess sandbox
  where Docker is unavailable) in dev.
- `agent/sandbox/workspace/**` seeds `/workspace`; skills are materialized for shell access.
- **Credential brokering:** the sandbox never receives connection or provider secrets.
  Authenticated egress goes through an app-side proxy that injects credentials per allowed
  host; the default network policy is deny-all.
- Sandbox tools go through the same approval (`requestInput`) and instrumentation path as any
  other tool.

## 9. The human surface — where React earns its place

React is not demoted to irrelevance; it moves to where it is the best tool.

- **`useAgent()`**: a hook (and an island) that subscribes to a session's `TurnEvent` SSE
  stream, renders deltas, tool progress and input requests, and sends messages and input
  answers. It is the web channel's client half.
- **Generative UI:** a tool may return a registered island reference
  (`{ ui: "OrderCard", props }`) alongside its text result. The web channel renders the island
  in the stream; non-web channels use the text. This is something a backend-only framework
  with an external frontend cannot do without a second component registry.
- **The operator inbox GUI** (`rfc-email.md` §9, last in its order) is built on June itself.

## 10. Packaging

- No package split in v0. The agent modules are already React-free; we **enforce** it with a
  lint rule like the existing zero-`node:*` rule (`agent*.ts`, `channels.ts`, `connections.ts`,
  `supervise.ts` may not import `react`).
- `create-june` gains `--template agent`. Its `package.json` does not list React.
- `june info` prints the full agent manifest (slots, subagents, schedules, memory provider,
  sandbox backend) next to the routes.
- Revisit an `@junejs/agent` package only if install size or the docs story demands it.

## 11. Phasing

Each slice ships independently, with docs on june.build and a `stability.md` entry.

| # | slice | depends on | size |
| --- | --- | --- | --- |
| 1 | Positioning: README, home, docs order, `--template agent`, React-free lint | — | S |
| 2 | Compaction (§6.1) | — | M |
| 3 | `schedules/` (§7.2), Workers Cron + native scheduler | — | M |
| 4 | Steering / turn policy (§6.2) | — | M |
| 5 | Multi-provider models (§6.3) | — | M |
| 6 | `subagents/` slot + cross-DO child routing (§7.1) | — | L |
| 7 | `evals/` + `june eval` (§7.5) | 5 helps | M |
| 8 | `memory.ts` (§7.3) | 2 | M |
| 9 | `hooks/` + OTel (§7.4) | — | S |
| 10 | `useAgent()` + generative UI (§9) | — | M |
| 11 | Sandbox (§8) | — | L |

Recommended first two: **1** (cheap, changes how every later slice is read) and **2 + 3**
together (small, and they decide whether an agent can run for long and act on its own).

## 12. Non-goals

- Becoming a workflow platform. Durability stays on our log-replay engine and Durable Objects.
- Removing or freezing the React layer. RSC, islands and the router keep evolving.
- Matching eve's channel and integration catalog one-for-one. Channels are added on demand.
- Dev-time self-modification. Coding agents already edit `agent/` well given `AGENTS.md`.

## 13. Open questions

1. **Name.** Is "agents that live inside real apps" the line, or does a shorter one exist?
   Does the package scope or the CLI description change?
2. **Compaction and the inbox.** Operators read the full transcript, the model reads from the
   checkpoint. Should operators see the checkpoint text too, and may they edit it?
3. **Steering on Slack.** Is a message edit (`message_changed`) a steer, or only a new message?
4. **Memory consent.** Should capture require an explicit tool call by default (opt-in
   memory) rather than automatic capture?
5. **Sandbox backend on Workers.** Cloudflare Sandbox vs Containers directly: cost per idle
   session and cold start need measuring before slice 11.
6. **Eval cost.** A default `--repeat` and a model budget guard for `june eval` in CI.
