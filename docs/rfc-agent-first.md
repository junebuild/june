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
| React-free agent runtime | ⚠️ source only: the agent modules import no React, and `examples/agent-edge` is a standalone Worker. Packaging does not follow: `react-dom` is a required peer of `@junejs/core` (only `react` is optional), `@junejs/server` requires both `react` and `react-dom`, and the CLI's app path mounts the agent through the web application | `packages/core/package.json`, `packages/june/package.json` |

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
  no `app/` pages, no React or react-dom installed — a packaging contract with an acceptance
  test, not just a template change (§10). Adding `app/` later turns it into a full June app
  with no migration, because both doors build the same assembly.

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
   the sandbox (§8) must preserve it, and a backend that cannot prove it does not start.
5. **Reuse the app.** Where an agent needs storage (memory, eval runs, schedules), the default
   backend is the app's own `db`/`kv`, not a new service.

## 6. Harness

### 6.0 Prerequisite: the Model contract

Compaction, steering and budgets all need things the `Model` seam does not carry today: the
terminal `done` delta has only `reply` and `finish`, and `Model` takes no abort signal —
`modelStep` polls cancellation only when the next delta arrives, so a provider that is silent
before its first token cannot be interrupted. One shared slice fixes the seam first:

- **Usage and model metadata:** `done` gains `usage: { inputTokens, outputTokens,
  cacheReadTokens?, cacheWriteTokens? }`, checkpointed with the reply so replay sees the same
  numbers. Each adapter exposes `contextWindow` (and `maxOutputTokens`) for the model id it
  resolved.
- **Provider-level cancellation:** `Model` opts gain `signal: AbortSignal`; adapters pass it to
  the provider SDK so an in-flight request is aborted, not merely abandoned at the next delta.
  The per-delta poll stays as a fallback for adapters that cannot abort.
- **Conformance tests per adapter:** usage present on `done`; abort before the first token
  ends the iterator promptly against a deliberately silent stub provider; abort after partial
  output discards it without a checkpoint.

### 6.1 Context compaction

A long session must not overflow the model's context window. Depends on §6.0.

- **Trigger:** before each model call, estimate input tokens (the last checkpointed
  provider-reported `usage.inputTokens` plus an estimate of messages appended since; a
  character-based estimate only when the provider reports no usage) against
  `compaction.thresholdPercent` (default `0.85`) of the adapter's `contextWindow`.
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
  pending model call through the §6.0 `signal`, append the new message, and continue **the
  same turn**. An executing tool
  always finishes and commits first. Once assistant text has streamed, steering applies at the
  next step boundary.
- Default per channel: `steer` for conversational channels, `queue` for HTTP and email.
- **Eligibility for folding and steering.** A turn runs under one trusted `principal`, one
  source/target and one effective policy (principal gate, `denyTools`). A queued message may
  fold into, and a steering message may join, a turn only when all three are identical to that
  turn's. Any other message — another speaker in a shared thread, an anonymous message, a
  different surface — starts a separate turn under its own identity. This keeps one user's
  message from ever executing under another user's tool authorization.
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
  practice) so adapters are judged on tool-calling behavior, not just text. Every adapter must
  also pass the §6.0 conformance tests.

### 6.4 Turn budgets

Compaction keeps the context small; it does not bound how much work a turn does. A tool loop
can keep calling tools indefinitely while staying under the context limit. Budgets are a
separate, explicit limit:

- `limits: { maxSteps, maxToolCalls, maxOutputTokens, maxWallClockMs }` per turn in
  `agent.ts`, overridable per surface and per schedule; token totals come from the §6.0
  checkpointed usage, so a replay counts the same.
- On reaching a limit the turn ends with `turn.failed { reason: "budget", limit }` by default,
  or parks for an operator to extend it (`onLimit: "ask"`) through the existing
  `requestInput` path.
- A session-level `maxTotalTokens` covers long-running sessions (a stable-id schedule, §7.2)
  across turns.

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
  connections.
- **Delegated policy — identity is not enough.** Passing the same `principal` alone would let a
  surface that denies a write tool on the parent reach it through a child that has it. So the
  `delegate_<name>` call carries a **policy envelope**: the turn's `principal`, `initiator`,
  inbound `source`, and the parent turn's effective `deniedTools`. The child's effective tool
  set is its own tools, filtered by the same principal gate, by its own
  `surfaces[source].denyTools`, and by the parent's denied names (a denial applies to a child
  tool of the same name); tools may also declare capability tags (`capabilities: ["write"]`)
  and a surface may deny by tag, which crosses the boundary regardless of tool names. The
  envelope is persisted with the child's start and suspend checkpoints, so replay and resume
  re-derive the same set, and it travels in the payload on both native dispatch and
  sibling-DO RPC (the child DO is reached only through the parent's worker, never directly
  from the network).
- **Widening is an explicit grant.** A child may hold a capability the parent's surface denies
  only if the parent's `agent.ts` lists it under `subagents.<name>.grants`, reviewed as
  policy. Without a grant, delegation never widens what the turn may do; with one, that is the
  stated exception.
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
- Lifecycle: recall **per turn**, for that turn's scope; capture before compaction and at
  session end, only from turns of the same scope. Recalled records are injected as a per-turn
  overlay — never appended to the persisted message history — so they are excluded from the
  summarizer and cannot outlive a scope change. They are attributed in the prompt (like
  notes: information, not instructions). Recall results are cached per scope within a session
  to keep the per-turn cost low.
- **Default provider is the app's own `db`** (a Juno table keyed by principal), so memory is
  ordinary app data: queryable, migratable, deletable on a user's request. This is a concrete
  case of "the agent lives inside the app".
- **Scoping is enforced by the framework, not trusted to the provider.** The runtime derives
  a mandatory scope key from the **current turn's authorized identity only** — the turn's
  resolved `principal` (or the tenant derived from it, when `memory.ts` declares
  `scope: "tenant"`). There is **no fallback to `initiator`**: like the `requiresPrincipal`
  gate, memory keys off the current speaker, so an anonymous follow-up in an
  operator-opened thread does not see or write the operator's memory. Background work with no
  inbound speaker (schedules, owner-driven jobs) must declare an explicit execution identity
  (`runAs`) in its definition, which the operator configures and reviews. Providers get an
  already-scoped handle, never a raw store. With no authorized scope, recall returns nothing
  and capture is refused (fail closed), and a `memory.*` TurnEvent records the skip. The
  default provider's table has the scope key in its primary key, so a cross-scope read is not
  expressible through it. Custom providers receive the same scope key and the docs state that
  keying on anything else is a tenant-isolation bug.
- **Scope changes inside a session.** Because recall is a per-turn overlay, a later turn with
  a different (or no) scope never sees records recalled for an earlier speaker. What the model
  *said* using those records does stay in the transcript, so for sessions where more than one
  distinct principal has spoken, memory is off by default; `memory.ts` must opt in with
  `shared: "thread"` to allow it, making the boundary an explicit, reviewable policy.

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
- Runs the **full agent loop with the real tool code** against a scratch database (the replay
  method we already use in practice).
- **No production side effects by default.** A scratch `db` and a stubbed `fetch` are not
  enough: actions can post to channels, write `kv`/`blob`, open a sandbox or call SDKs
  directly. The eval host therefore binds **deny-or-stub test adapters for every external
  capability**: channel delivery records instead of posting, `kv`/`blob` are scratch
  instances, the sandbox is a disposable local backend, connections resolve to recorded
  fixtures, and outbound network from tool code is blocked (a direct call fails the case with
  a clear error rather than reaching a real service). A real integration is used only when a
  case opts in by name (`live: ["slack"]`), and `june eval` refuses live cases unless
  `--allow-live` is passed.
- `june eval [--model <id>] [--repeat n]` reports pass rate per case and variance across
  repeats, so a model or prompt change is judged on numbers.

## 8. Sandbox

The largest and last slice. Agents that analyze data or touch code need a filesystem and
processes; June has neither for the model.

- Contract `Sandbox { run, spawn, readFile, writeFile, setNetworkPolicy }`, opened lazily per
  session by `ctx.getSandbox()`, handle checkpointed so replay resumes the same sandbox.
- Default tools `bash`, `read_file`, `write_file` occupy `tools/` slots and are replaceable or
  disableable like any authored tool. They are **off** unless `sandbox.ts` exists.
- **Backends must prove the isolation they claim.** Each backend declares capabilities —
  filesystem isolation (no host paths beyond `/workspace`), environment isolation (no
  inherited host env), and enforceable network policy (deny-all plus the broker). At startup
  the configured policy is checked against them; if the selected backend cannot enforce it,
  the agent **refuses to start** with shell/file tools enabled. There is no silent fallback.
- Backends: Cloudflare Sandbox/Containers on Workers; local Docker in dev. A plain subprocess
  backend qualifies only with specified OS isolation (a separate user, a filesystem jail, a
  scrubbed environment and a network namespace or equivalent). An intentionally unsafe local
  mode exists only as an explicit `unsafeLocal: true`, logs on every session, and is refused
  by `june build`.
- **Backend conformance suite:** from inside the sandbox, a direct outbound request to a
  public host fails; reading a canary host secret (an env var set on the host, a canary file
  outside `/workspace`) fails; a request through the broker to an allowed host succeeds with
  the credential injected and never visible inside the sandbox.
- `agent/sandbox/workspace/**` seeds `/workspace`; skills are materialized for shell access.
- **Credential brokering:** the sandbox never receives connection or provider secrets.
  Authenticated egress goes through an app-side proxy that injects credentials per allowed
  host; the default network policy is deny-all.
- Sandbox tools go through the same approval (`requestInput`) and instrumentation path as any
  other tool.

## 9. The human surface — where React earns its place

React is not demoted to irrelevance; it moves to where it is the best tool.

### 9.1 Prerequisite: a reconnectable session protocol

There is no reusable subscription surface for a client yet: replay catch-up is in-process
only, no host exposes a reconnectable events endpoint, and a pending `input.requested` is not
folded into replay. A browser reload during an approval would lose the prompt. Before any
client consumes sessions, one authenticated protocol serves all of them:

- **Snapshot:** `GET` a session → status, pending input requests (prompt, schema, who may
  answer), the transcript head, and the event cursor it reflects.
- **Events:** an SSE stream from a cursor. The cursor is versioned and monotonic per session;
  resuming from a snapshot's cursor is gap-free (structural events folded from the log, then
  live), and a cursor older than retention returns an explicit "resnapshot" signal rather than
  a silent gap.
- **Operations:** send a message (with `turnPolicy`), respond to an input request, cancel a
  turn.
- **Authentication and per-session authorization.** Every endpoint authenticates the caller
  (the app's auth, or a June-issued scoped token as in the inbox work); a session id is an
  identifier, never a bearer capability. Each operation is authorized against that session
  separately: *read* (snapshot, events) for the session's participants and authorized
  operators; *send* for callers allowed to speak in it, whose message then runs under their
  own principal (§6.2 eligibility); *respond* only for the request's `answerers`, as today;
  *cancel* for the turn's speaker and operators. An unauthorized caller gets the same 404 as
  a missing session, so ids cannot be probed.
- It should share shape and auth with the inbox API (`/_june/inbox/v1`, #297) rather than
  become a second operator API.
- **Acceptance cases:** reconnect during a pending approval shows the same prompt and accepts
  the answer; reconnect after a host restart (DO eviction, native process restart) resumes
  from the cursor with no lost or duplicated structural events.

The plain client SDK, the TUI and `useAgent()` all consume this one protocol.

### 9.2 React on top of it

- **`useAgent()`**: a hook (and an island) built on the §9.1 protocol: it snapshots, streams
  from the cursor, renders deltas, tool progress and pending input requests, and sends
  messages, input answers and cancels. It is the web channel's client half.
- **Generative UI:** a tool may return a registered island reference
  (`{ ui: "OrderCard", props }`) alongside its text result. The web channel renders the island
  in the stream; non-web channels use the text. This is something a backend-only framework
  with an external frontend cannot do without a second component registry.
- **The operator inbox GUI** (`rfc-email.md` §9, last in its order) is built on June itself.

## 10. Packaging

"No React installed" (§4.3) is an **install/build acceptance contract**. Checking source
imports alone cannot establish it, because the dependency graph and the CLI's entrypoints pull
React in today (§3). The slice therefore includes:

- **Peers:** `react-dom` becomes optional in `@junejs/core`; `react` and `react-dom` become
  optional peers of `@junejs/server`, with every renderer import behind entrypoints that only
  the app path loads.
- **Entrypoints:** an agent-only path for `june dev` and `june build` that discovers `agent/`,
  serves its channels and session protocol, and never imports the renderer, the App Router or
  the RSC pipeline when there is no `app/` directory.
- **Source rule:** a lint rule like the existing zero-`node:*` rule (`agent*.ts`,
  `channels.ts`, `connections.ts`, `supervise.ts` may not import `react`).
- **Acceptance fixture:** CI packs the packages (`npm pack`), installs them into a clean
  directory with an agent-only project, and runs `june dev` (one HTTP turn) and `june build`
  with no `react`, `react-dom` or `app/` present. It fails if either command resolves a React
  module.
- `create-june` gains `--template agent`, whose `package.json` lists no React. A package split
  stays optional.
- `june info` prints the full agent manifest (slots, subagents, schedules, memory provider,
  sandbox backend) next to the routes.
- Revisit an `@junejs/agent` package only if install size or the docs story demands it.

## 11. Phasing

Each slice ships independently, with docs on june.build and a `stability.md` entry.

| # | slice | depends on | size |
| --- | --- | --- | --- |
| 1 | Positioning: README, home, docs order | — | S |
| 2 | Agent-only packaging: optional React peers, agent-only CLI entrypoints, `--template agent`, packed-package fixture (§10) | — | M |
| 3 | Model contract: usage + context window, abort signal, adapter conformance (§6.0) | — | M |
| 4 | Compaction (§6.1) | 3 | M |
| 5 | Turn budgets (§6.4) | 3 | S |
| 6 | `schedules/` (§7.2), Workers Cron + native scheduler | — | M |
| 7 | Steering / turn policy (§6.2) | 3 | M |
| 8 | Multi-provider models (§6.3) | 3 | M |
| 9 | `subagents/` slot + cross-DO child routing + delegated policy (§7.1) | — | L |
| 10 | `evals/` + `june eval` (§7.5) | 8 helps | M |
| 11 | `memory.ts` (§7.3) | 4 | M |
| 12 | `hooks/` + OTel (§7.4) | — | S |
| 13 | Session protocol: snapshot, cursor, send / respond / cancel (§9.1) | — | M |
| 14 | `useAgent()` + generative UI (§9.2) | 13 | M |
| 15 | Sandbox with backend conformance (§8) | — | L |

Recommended order to start: **1** (cheap, changes how every later slice is read), then **3**
(it unblocks four slices), then **4 + 6** together (they decide whether an agent can run for
long and act on its own).

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
   session and cold start need measuring before slice 15.
6. **Eval cost.** A default `--repeat` and a model budget guard for `june eval` in CI.
