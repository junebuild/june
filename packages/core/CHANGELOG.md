# @junejs/core

## 0.1.1-dev.22

### Patch Changes

- [#112](https://github.com/junebuild/june/pull/112) [`6e31981`](https://github.com/junebuild/june/commit/6e319810e5888875434656f282e57818ec895229) Thanks [@linyiru](https://github.com/linyiru)! - `slackChannel(...).diagnose()` ([#90](https://github.com/junebuild/june/issues/90)) — preflight diagnostics as one structured, read-only call: verifies the bot token (`auth.test`), compares granted scopes (the `x-oauth-scopes` response header) against what the ENABLED features need (stream/status → `assistant:write`, reaction events → `reactions:read`, …), and reports per-isolate delivery counters (events received per kind — un-normalizable events count under their raw Slack type — plus interactions split three ways: claimed by a built-in branch / delivered to `onInteraction` (`appHandled`) / unrouted, and rejection counts). `hints` renders the findings as one-liners: "app_mention received: 0 since this isolate started — check Socket Mode is OFF and the Events Request URL points at this deployment" is the packaged answer to the silent-failure hunt that motivated the issue.

## 0.1.1-dev.21

### Patch Changes

- [#110](https://github.com/junebuild/june/pull/110) [`7a6c6e6`](https://github.com/junebuild/june/commit/7a6c6e6887986f027b2bde5e595e1de98b7442d5) Thanks [@linyiru](https://github.com/linyiru)! - New `@junejs/core/test` entry ([#93](https://github.com/junebuild/june/issues/93)) — the test scaffolding every June app was re-implementing by hand, shipped inside core so the fakes stay in version-lockstep with the surfaces they mirror (a subpath, not a separate package, so drift is structurally impossible and there is nothing extra to install):

  - `signSlackRequest(secret, body, { ts?, url? })` / `signCrispRequest(…)` — build a `Request` that passes the real channels' signature verification (ts override for staleness tests).
  - `makeTestContext({ reply?, streamEvents?, detached?, resumeEvents?, services?, agent? })` — a fake `ChannelContext` with call capture (`ctx.calls.run/runStream/runDetached/resumeStream/waitUntil`) and `ctx.flush()`, an exact join on fast-ACK background work (including work enqueued while settling) that replaces sleep-based flushing. Optional surfaces (`runStream`/`runDetached`/`resumeStream`) appear only when their fixture is provided, keeping channel feature-detection honest.
  - `turnEvents({ reasoning?, deltas?, text? | fail? | input? })` — build a turn's streaming fixture: `turn.started`, deltas, exactly one terminal.

## 0.1.1-dev.20

### Patch Changes

- [#108](https://github.com/junebuild/june/pull/108) [`410928a`](https://github.com/junebuild/june/commit/410928a389db7c2e07434ee03f02b94914202d0f) Thanks [@linyiru](https://github.com/linyiru)! - Channel outbound + interaction completeness ([#88](https://github.com/junebuild/june/issues/88), [#89](https://github.com/junebuild/june/issues/89), and the observability half of [#90](https://github.com/junebuild/june/issues/90)):

  - `channel.post(target, content)` ([#89](https://github.com/junebuild/june/issues/89)) — deterministic outbound post (no LLM, no stream) over the channel's own auth/transport, returning the sent message's identity (`{ channelId, threadId?, ts }`; `ts` is Slack's message ts / Crisp's fingerprint). Unlike the best-effort reply path it throws loudly on a platform error. Implemented on both `slackChannel` and `crispChannel`.
  - `slackChannel({ onInteraction })` ([#88](https://github.com/junebuild/june/issues/88)) — every signature-verified interaction payload the built-in routing does not claim (`june_feedback` / `june_input:*`) is handed to the app instead of silently dropped, so an app's own buttons ride the same endpoint (no parallel webhook, no duplicated signature verification).
  - `feedbackBlocks(turnId?, session?)` is now exported ([#88](https://github.com/junebuild/june/issues/88)) — a message the app posts itself (via `channel.post`) can carry the same native 👍/👎 the streamed reply gets, and clicks route through the same `onFeedback`.
  - `onRejected(rejection, req)` on both channels ([#90](https://github.com/junebuild/june/issues/90)) — names the silent turn-away paths (`bad_signature`, `malformed_body`, `unrouted_interaction`). Observability only; never changes the response, and a throwing hook is contained.

## 0.1.1-dev.19

### Patch Changes

- [#106](https://github.com/junebuild/june/pull/106) [`6a915e4`](https://github.com/junebuild/june/commit/6a915e4f3e2c07b8b35b086e1033836dae6696b3) Thanks [@linyiru](https://github.com/linyiru)! - `ToolCall.providerState` ([#92](https://github.com/junebuild/june/issues/92)) — opaque round-trip state for model adapters. Some providers attach state to tool calls that must be replayed verbatim (Gemini 3+ rejects replays omitting its per-call `thoughtSignature`); adapters previously smuggled it inside the call id, leaking it into ledgers keyed by callId and breaking on id normalization. The field is written by the adapter, stored on the assistant message with the call, and handed back untouched on replay — the engine never reads it and it is never part of identity (step keys and dispatch use `id` alone).

## 0.1.1-dev.18

### Patch Changes

- [#103](https://github.com/junebuild/june/pull/103) [`a10a457`](https://github.com/junebuild/june/commit/a10a457b8dddebbe76a15a9961da28d264dfb76b) Thanks [@linyiru](https://github.com/linyiru)! - Minted turn ids are now globally unique and lexically time-sortable ([#95](https://github.com/junebuild/june/issues/95)): `t_` + a monotonic ULID replaces the per-actor sequence. The old ids collided in both dimensions — across sessions (every session's first turn was `t1`, useless in any table keyed by turnId), and within one session across a DO hibernation (the in-memory seq reset re-minted `t1`, which the engine then treated as a redelivery of the old turn and silently replayed its steps). Explicitly passed `turnId`s are untouched; legacy `t<n>` ids sort before every new id, so a mixed ledger stays ordered across the migration boundary. New export: `mintTurnId()`.

## 0.1.1-dev.17

### Patch Changes

- [#101](https://github.com/junebuild/june/pull/101) [`0703648`](https://github.com/junebuild/june/commit/07036488b678e7cc6b17434d916908320a8fd7f8) Thanks [@linyiru](https://github.com/linyiru)! - `isCrispEvent` now also requires `data` to be a non-null object ([#91](https://github.com/junebuild/june/issues/91)) — the webhook envelope is parsed from untrusted JSON, and a malformed delivery (null/missing/scalar `data`) used to pass the guard and throw on the first `payload.data.x` access downstream; it now fails the narrow (and `normalizeCrispEvent` drops it) instead. Also exports `CrispWebhookEnvelope` — the all-optional envelope shape (`website_id` / `event` / `data` / `timestamp`) apps kept re-declaring; the guard's narrowed type now includes it, so envelope fields stay readable after the narrow.

## 0.1.1-dev.16

### Patch Changes

- [#99](https://github.com/junebuild/june/pull/99) [`d323e45`](https://github.com/junebuild/june/commit/d323e458f5889b9179b137425af2ae8718b24d6e) Thanks [@linyiru](https://github.com/linyiru)! - `@junejs/core` is now a peerDependency of `@junejs/server` ([#94](https://github.com/junebuild/june/issues/94)) — the app's single core resolution always wins, so a package manager can no longer nest a second, older core copy under server (the version-skew class that surfaced in production as a mid-turn `sink.emit is not a function`).

  Belt-and-braces: core exports `RUNTIME_API_VERSION`, and server asserts it at surface construction (`AgentDurableObject`, `NativeRuntime`) — a skewed tree now fails at power-on with both versions named instead of mid-turn.

  Migration: npm ≥7 / bun / pnpm auto-install required peers, so most apps need no change; if your tool doesn't, add `@junejs/core` to the app's dependencies (it almost certainly already is).

## 0.1.1-dev.15

### Patch Changes

- [#97](https://github.com/junebuild/june/pull/97) [`2e4cc43`](https://github.com/junebuild/june/commit/2e4cc43cabe64bc569c9f6039ffc6f68765c328f) Thanks [@linyiru](https://github.com/linyiru)! - Turn failures carry the full error, serialized at the throw site ([#96](https://github.com/junebuild/june/issues/96)):

  - `turn.failed` (and `TurnResult`'s failed arm) now carry `TurnError` — `{ message, stack?, causeChain? }` — plus `phase` ("model" | "tool") and `step` (the in-flight step id, e.g. `model:3` / `tool:call_7`) naming what was running when the turn died. Non-Error throwables keep their JSON shape instead of collapsing to "[object Object]".
  - `onTurnError` receives the extended payload unchanged from the failure site — for a detached turn this hook is the only failure-surfacing path, so nothing is flattened before it fires. Backwards-compatible: all new fields are additions.
  - The DO's default failure log (wrangler tail) prints the step and the real stack trace (plus a `caused by:` chain) instead of the message alone.
  - The SSE-collapsing paths (`sseTurnFinalText`, the channel non-streamed reply) rethrow with the full `TurnError` as `cause`.
  - New export: `serializeTurnError(err)` (cycle-capped `cause` walk).

## 0.1.1-dev.14

### Patch Changes

- [#86](https://github.com/junebuild/june/pull/86) [`09d9901`](https://github.com/junebuild/june/commit/09d99010df4865fed38cfa64c79efeccb200c0b0) Thanks [@linyiru](https://github.com/linyiru)! - Fire-and-forget turn mode ([#77](https://github.com/junebuild/june/issues/77)): `POST /turn?detach=1` makes the Durable
  Object respond 202 as soon as the turn is durably accepted and run it under
  its OWN lifetime — a DO stays alive while it has pending work — instead of
  bounding turn duration by however long the caller can hold a connection
  (the edge worker's post-ACK waitUntil ceiling killed 24–38s shadow turns in
  production). `ChannelContext` gains an optional `runDetached(message, opts)
→ { turnId }`, implemented by both `durableChannelSurface` (edge) and
  `mountAgent` (native), and `AgentDurableObject` gains `start()` for custom
  shells. Detached turns have no live consumer: failures surface via the
  default turn-failure log / `onTurnError`. The awaited `/turn` SSE contract
  is unchanged.

## 0.1.1-dev.13

### Patch Changes

- [#80](https://github.com/junebuild/june/pull/80) [`7c2c820`](https://github.com/junebuild/june/commit/7c2c820689370a71c9f114e6aac520e4e3030bcf) Thanks [@linyiru](https://github.com/linyiru)! - `useStore` hydrates against the store's INITIAL value (the true server snapshot), not the current one — fixing a hydration mismatch (React [#418](https://github.com/junebuild/june/issues/418)) when an island mutates the store before a later island hydrates.

  Islands hydrate at different times (each loads its own chunk), so a user could click an already-live AddToCart before CartBadge hydrated; the badge would then hydrate against the moved store value while its SSR HTML still held the initial one. `createStore` now exposes `getInitial()` and `useStore` passes it as `getServerSnapshot`, so hydration always matches the SSR HTML and React re-renders to the current value right after. This also removes the same recoverable error on soft-navigation re-hydrates, and was the root cause of the flaky `store-e2e` test.

## 0.1.1-dev.12

### Patch Changes

- [#78](https://github.com/junebuild/june/pull/78) [`7aee078`](https://github.com/junebuild/june/commit/7aee0786f2a28f78e20afe1f56b7d3991514a3b3) Thanks [@linyiru](https://github.com/linyiru)! - Slack DM streams omit recipient ids (live-verified): chat.startStream's recipient rule cuts both ways — a channel stream requires `recipient_user_id`/`recipient_team_id` (`missing_recipient_team_id`), while a DM stream rejects them (`invalid_arguments`). The renderer now branches on the im channel's D-prefix, so streaming works in both surfaces. Also documents the observed rendering surfaces: task cards render in regular channels; feedback buttons attach everywhere but clients may only render them in the agent DM; the Stop affordance is agent-surface-only (our `stopped_by_user` handling is defensive regardless).

## 0.1.1-dev.11

### Patch Changes

- [#73](https://github.com/junebuild/june/pull/73) [`932e46f`](https://github.com/junebuild/june/commit/932e46f9d54e67f88b386a33bebf4ed82e56ff08) Thanks [@linyiru](https://github.com/linyiru)! - Slack agent-era surfaces: native feedback buttons + tool-call task timeline.

  - `slackChannel({ feedback: true })` — the streamed reply finalizes with Slack's native 👍/👎 (`chat.stopStream` carries a `context_actions` block with `feedback_buttons`); clicks arrive normalized in `onFeedback` as `SlackFeedback` ({rating, turnId, session, user, channelId, threadId, messageTs}) — pure telemetry, background + best-effort.
  - `slackChannel({ tasks: (call) => title })` — tool calls render as Slack's native task timeline inside the streamed message (`task_update` chunks: in_progress on action.requested, complete on action.completed; `taskDisplayMode` picks timeline/plan/dense). Opt-in because it deliberately departs from lazy-start: a tool-only turn now posts the timeline. Chunk failures are decorative loss (reported, never truncating text); the postMessage fallback stays text-only.
  - Two live-verified contract fixes: channel streams carry `recipient_user_id`/`recipient_team_id` even in-thread (`missing_recipient_team_id` otherwise — inbound events now thread the envelope's `team_id` through `InboundEvent.teamId` and stream to the asker), and a task-enabled stream runs entirely in chunks mode (`streaming_mode_mismatch` forbids mixing raw `markdown_text` into a chunks-opened stream).
  - Live contract suite grows preflight diagnostics and a chunks + feedback-blocks case.

## 0.1.1-dev.10

### Patch Changes

- [#71](https://github.com/junebuild/june/pull/71) [`771772f`](https://github.com/junebuild/june/commit/771772f4f790a4fc48d4782ac5a7bff9e99f9943) Thanks [@linyiru](https://github.com/linyiru)! - Harden Slack native streaming against the chat.startStream contract + the agent-era status line.

  - `chat.appendStream` errors are no longer ignored: `stopped_by_user` (the human hit Stop) ends rendering; `ratelimited` retries once honoring Retry-After; anything else surfaces via `onError` and the unsent tail posts via `chat.postMessage` — no silent truncation.
  - Token deltas now coalesce (~2 flushes/s, sliced at Slack's 12k markdown cap) so a long turn can't spend appendStream's Tier-4 budget; the first token still seeds the stream immediately.
  - `DeliveryTarget` grows `recipientUserId`/`recipientTeamId` — chat.startStream requires them to open a TOP-LEVEL channel stream (no `thread_ts`), which proactive delivery can now do natively.
  - `slackChannel({ status: "is thinking…" })` shows the assistant thread status while a turn runs (`assistant.threads.setStatus`, best-effort); Slack clears it when the reply posts, and a tool-only turn clears it explicitly.
  - Opt-in live contract suite: `SLACK_LIVE_BOT_TOKEN` + `SLACK_LIVE_CHANNEL` run `test/slack-live.test.ts` against the real api.slack.com.

## 0.1.1-dev.9

### Patch Changes

- [#69](https://github.com/junebuild/june/pull/69) [`19aa6e3`](https://github.com/junebuild/june/commit/19aa6e38a2a0e2cc42e2173ecdb4db94feb9490b) Thanks [@linyiru](https://github.com/linyiru)! - `crispChannel` normalizes a curated set of Crisp webhook events beyond visitor text, with typed payloads — the crisp dual of the Slack channel's `events`/`respondTo`/`on` surface:

  - **New normalized kinds** (subset of the dashboard-subscribable catalog): `message:updated` → `message_changed`, `session:set_state` → `state_changed` (resolved/unresolved/pending — the resolve-hand-off hook both website and plugin hooks deliver), `session:sync:rating` → `rating` (CSAT stars + comment, riding on the new `InboundEvent.rating`/`InboundEvent.state` fields). Kinds without natural text synthesize a note as the turn's `userText`, like Slack reaction turns.
  - **`events` / `respondTo` / multi-kind `on`** on `crispChannel`, with the same intent-derivation as `slackChannel` (`respondTo`/`on` keys derive the normalize list; explicit `events` overrides; no intent → visitor messages only, the prior behavior). `respondTo: ["message", "rating"]` lets a bad CSAT score drive a follow-up turn in the SAME conversation session; `on: { rating }` observes it deterministically (no LLM).
  - **`normalizeCrispEvent(payload, events)`** exported — the crisp dual of `normalizeSlackEvent`, so a hand-rolled channel reuses the normalization (loop guards included: operator-authored messages never normalize).
  - **Typed raw payloads**: `CrispEventPayloads` types the `data` shapes of the dashboard-subscribable events an app actually consumes (`message:send/received/updated/removed`, `session:set_state`, `session:sync:rating`, `session:removed`); `isCrispEvent(raw, name)` narrows an `onEvent` raw to them — autocomplete instead of hand-rolled casts. The long tail (campaign/bucket/email/…) deliberately stays `unknown`.
  - Docs note the sharp edge: which events arrive at all is decided by the Crisp dashboard's hook checkboxes — the channel options only filter. Website hooks expose a subset of the full catalog (no `session:request:initiated`, no `session:set_opened/closed`), so resolve flows should key off `session:set_state`.

## 0.1.1-dev.8

### Patch Changes

- Suspend/resume (HITL) + proactive turns — RFC P3, P3b, P4 (see docs/rfc-turn-as-live-process.md). The turn-as-live-process RFC is now fully shipped.

  - **P3 — suspend / resume (HITL)**: a tool pauses a turn for human input with `ctx.requestInput({ id, prompt, answererId? })`; the turn parks durably as a consumable `suspended` checkpoint (the DO can hibernate) and emits `input.requested`. `AgentSession.resume(turnId, inputId, input, { by })` validates the target + inputId and enforces the answerer (default-deny when `answererId` is set), then replays the same durable step-checkpoint machine — exactly-once, now "a step whose result comes from a human". The DO gains a streamed `POST /resume`; `/turn` and `/resume` map suspension conflicts to 4xx (403 unauthorized answerer, 409 wrong/parked turn) instead of crashing.
  - **P3b — Slack HITL**: `input.requested` renders Approve/Deny Block Kit buttons (`june_input:*`); a signed `block_actions` interaction routes to `resume` with the clicker's verified id. A rejected click (wrong/stale answerer) leaves the buttons intact and tells only the clicker (ephemeral); HITL works in both stream and post-once render modes; dead ends (unusable payload, no resumeStream) surface via `onError`.
  - **P4 — proactive / agent-initiated**: a distinct `trigger`-role `Msg` opens a proactive turn attributed to `by` (a schedule, another channel, the agent), mapped to a user message at the model adapter (no new provider role). `channel.deliver(target, events)` renders a turn's stream to a `DeliveryTarget` with no inbound event; `receive(channel, ctx, { seed, target, trigger, session })` starts the proactive turn and wires its stream to `deliver`. The trigger threads through the edge (`serializeTurn` → DO `/turn` → `session.start`).

## 0.1.1-dev.7

### Patch Changes

- [#65](https://github.com/junebuild/june/pull/65) [`b20cc77`](https://github.com/junebuild/june/commit/b20cc7726736cfc48506e7a5d06ab7eddba9f466) Thanks [@linyiru](https://github.com/linyiru)! - `crispChannel` supports Crisp **website hooks** (dashboard-configured, unsigned) alongside plugin hooks:

  - New `auth` option, a discriminated union naming which webhook contract you're on: `{ type: "signature", secret }` (plugin hooks — HMAC + replay guard, unchanged) or `{ type: "urlKey", key, param? }` (website hooks — Crisp's documented shared-key-in-URL pattern, compared in constant time; default param `key`).
  - `signingSecret` stays as the plugin-hook shorthand (`≡ auth: { type: "signature", secret }`). Exactly one of `auth`/`signingSecret` is enforced at the type level (both/neither is a compile error), with construction-time throws as the runtime backstop — a channel that silently 401s every delivery is much harder to diagnose.
  - In `urlKey` mode an invalid key is rejected before the request body is read; `signature` mode reads first because the MAC covers the raw body.
  - `verifyCrispUrlKey(expectedKey, url, param?)` is exported next to `verifyCrispSignature` (composability floor). An empty configured key always fails — same closed-by-default posture as an empty signing secret — and unparseable URLs fail closed (never throw); path-relative URLs are accepted.

## 0.1.1-dev.6

### Patch Changes

- Streaming-first Model + native Slack token streaming (RFC P2, see docs/rfc-turn-as-live-process.md).

  - `Model` is now `(msgs, tools, opts?) => AsyncIterable<ModelDelta>` where `ModelDelta = reasoning | text | done`; a one-shot reply is the degenerate case. `replyStream(reply)` builds it for non-streaming models.
  - The anthropic adapter unfolds the SDK message stream into `text`/`thinking` deltas, then `finalMessage()` as the authoritative `done.reply`. `modelStep` emits `reasoning.delta`/`message.delta` as live TurnEvents and checkpoints `done.reply` (treating `done` as terminal).
  - `slackChannel({ stream: true })` streams tokens into ONE message via Slack's native `chat.startStream` → `appendStream` → `stopStream` (seeded with the first token), lazily — a tool-only/empty turn posts nothing; failures are always surfaced; falls back to `chat.postMessage` when `startStream` is unavailable.

## 0.1.1-dev.5

### Patch Changes

- The turn as a live process — P1 (see docs/rfc-turn-as-live-process.md). A turn is no longer only `Promise<string>`; it emits a durable, observable stream of typed events.

  - **TurnEvent bus**: `runTurn` emits structured events (`turn.started`, `action.requested`/`completed`, `message.completed`, `turn.completed`/`failed`) at its step boundaries; `Broadcaster.publish(turnId)` is now `EventSink.emit(TurnEvent)`.
  - **`start` / `result` / `observe`**: `AgentSession.start(input) => { turnId }` (non-blocking) + `result(turnId) => Promise<TurnResult>` (completed | failed); `observe(cb, { turnId?, replay? })` folds the structural prefix from the durable log for a late/reconnecting subscriber, then goes live. `turn() => Promise<string>` stays as the non-interactive convenience.
  - **SSE transport**: the Durable Object `/turn` streams TurnEvents as `text/event-stream` (with `no-store` + a `:hb` heartbeat); `durableAgentSurface` pipes it through on `Accept: text/event-stream` (live chat) or collapses to `{ text }`.
  - **Channel render**: `ChannelContext.runStream` exposes the live TurnEvent stream; `slackChannel({ stream: true })` posts "Thinking…" then edits that one message in place (tool status → final answer). Exported primitives: `sseTurnEvents`, `sseTurnFinalText`.

  Token-level streaming into the same message (`reasoning.delta`/`message.delta`), suspend/resume (HITL), and proactive turns are the following phases (P2–P4).

## 0.1.1-dev.4

### Patch Changes

- Channel hooks round 2 — less transport glue in a thin wrapper:

  - **`on` (per-kind observers)**: `slackChannel({ on: { reaction_added: (event, ctx) => … } })` — a typed handler that fires only for its kind, only when a normalized event exists (post bot/loop guards), so `event` is non-optional and there's no `event.kind` demux or `event?` guard. Coexists with `onEvent` (the raw firehose). `crispChannel` gets `on.message`.
  - **`ctx.services` (hook-level DI)**: channel hooks run at the edge, outside the Durable Object, so they can't read the DO's `currentServices()`. `durableChannelSurface({ services: (env) => makeServices(env) })` (and `mountAgent({ services })`) resolve the SAME factory and expose it as `ctx.services` — one DI story for edge and turn; a hook writes via `ctx.services.feedback.record(…)` instead of re-plumbing bindings.
  - **Derived `events`**: when omitted, the Slack subscribe list is derived from `respondTo` + `on` keys (union) so kinds aren't written twice and can't drift; pass `events` explicitly to override. The friendly default (message + app_mention) still applies when no intent is expressed.

## 0.1.1-dev.3

### Patch Changes

- Channel turn-control + source-aware prompts, so a shared agent needs far less custom channel code:

  - **`respondTo`** (slackChannel): per-KIND control over which subscribed events drive a turn+reply; the rest reach only `onEvent`. e.g. `events:["app_mention","reaction_added"], respondTo:["app_mention"]` runs a turn for a mention but treats a reaction as a deterministic observe (no LLM).
  - **`channelInstructions`** (defineAgent / DoAgentDef): per-source system overlays. When a turn's `InboundEvent.source` matches a key, that text is appended to the system prompt — a shared agent branches on the real, unforgeable source instead of a userText marker. `withSystem` now appends a per-turn overlay to the base instead of dropping it.
  - **AgentDurableObject `channels` + `env`**: builds a mounted channel's capability tools inside the DO (a tool's run closure can't cross the worker→DO RPC) — the edge equivalent of `defineAgent` merging `channel.tools()` on native.
  - **Exported primitives**: `verifySlackSignature`, `verifyCrispSignature`, `normalizeSlackEvent`, `tryParseJson`, `timestampFresh` — a hand-rolled channel reuses the crypto/normalization instead of re-implementing it.

## 0.1.1-dev.2

### Patch Changes

- Channel extension seams: `onEvent` (observe/mirror), `mode`, and `accept` on slackChannel + crispChannel.

  An app can now sit on the built-in channel instead of forking its webhook — inheriting all the signature/replay/malformed/blank hardening:

  - `onEvent({ raw, event })` — a background mirror hook called for EVERY signature-verified event, before the turn's loop guard (so operator/bot/non-text events are visible too). For ingesting a conversation into an app store (e.g. a RAG source of truth).
  - `mode: "observe"` — shadow mode: never run a turn or post a reply; only `onEvent` fires. `mode: "respond"` (default) keeps replying and still fires `onEvent`.
  - `accept(raw)` — gate a verified event before any work (returns false → ACK 200, ignore); a website/channel allowlist lives here.

## 0.1.1-dev.1

### Patch Changes

- Channel webhook hardening (slack + crisp):

  - Replay guard: crispChannel now rejects a stale timestamp (±5 min), matching slackChannel. The shared `timestampFresh` helper is unit-agnostic (Slack sends seconds, Crisp milliseconds).
  - Malformed body: a signature-valid but unparseable webhook body now ACKs 200 and is dropped instead of throwing — a 5xx would make the platform redeliver the same broken event forever (retry storm).
  - Inbound guard: a whitespace-only visitor message no longer triggers an agent turn.

## 0.1.1-dev.0

### Patch Changes

- Channel capabilities: agents can now read and act on chat platforms, not just echo text.

  - `InboundEvent` normalized envelope threaded into turn + tool context (`ToolContext.event`), carried end-to-end over the durable `/turn` RPC and the native path.
  - Channels can contribute outbound capability tools (`Channel.tools`), merged into `agent.tools` by `defineAgent` (which now throws on a duplicate tool name).
  - Slack: `slack_read_thread`, `slack_list_reactions`, `slack_resolve_user`, `slack_add_reaction`; `message` / `app_mention` / `reaction_added` / `reaction_removed` event turns (reactions opt-in via `events`, `botUserId` loop guard).
  - Crisp: normalized envelope + `crisp_read_conversation`; empty replies no longer posted.
  - Cross-channel safety: tools default their target from the current event only when `event.source` matches. Durable `/turn` serialization drops an unserializable `event.raw` instead of failing the turn.

## 0.1.0

### Minor Changes

- [`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f) Thanks [@linyiru](https://github.com/linyiru)! - Auto-mount the durable agent from `june.config` (build order step 4).

  - `@junejs/core/config`: an `agent.runtime` block (`enabled` / `dir` / `backend` /
    `chat.path` / `channels`), resolved by `resolveAgent`. `channelFetch` now
    returns `Response | null` so it composes as a fall-through surface.
  - `@junejs/server`: the shared render pipeline gains an `agentSurface` slot (runs
    after the static agent surface `/mcp` + discovery, before middleware/routes).
    `mountAgent` gains `surface` — a framework chat endpoint at `chat.path` (POST
    `{message, session?}` → a durable turn) plus the discovered channels. The dev
    server auto-discovers an `agent/` directory and mounts it with an Anthropic
    model: drop an `agent/` folder and `POST /message`, `/channels/*`, and `/mcp`
    (its tools) are all live — no glue.

  Edge (worker.ts + Durable Object routing) is a follow-up; dev auto-mount ships now.

- [`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3) Thanks [@linyiru](https://github.com/linyiru)! - Add agent channels — inbound edges (http / slack / crisp).

  - `@junejs/core/agent-config` — the `Channel` / `ChannelContext` contract,
    `defineChannel`, and `channelFetch` (a pure Web-standard router that dispatches
    webhook channels by path and http channels by fall-through). `AgentDefinition`
    now carries `channels`.
  - `@junejs/core/channels` — built-in channel factories: `httpChannel` (POST
    /message + optional /mcp), `slackChannel`, `crispChannel`. Web-standard
    (`crypto.subtle` HMAC verification, `fetch` reply-out — zero `node:*`, edge-
    ready). Secrets are injected as options, so the channel stays portable across
    native and edge; loop guards (bot/operator self-messages) prevent reply loops.
  - `@junejs/server` — `discoverAgent` now scans `channels/*.ts`; new `mountAgent`
    builds a `ChannelContext` whose `run` bridges to a durable turn and returns a
    fetch handler (webhooks + http) plus `startAll` for one-shot channels (cli).

- [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d) Thanks [@linyiru](https://github.com/linyiru)! - Add agent connections — outbound tool sources (the mirror of channels).

  - `@junejs/core/connections` — `defineMcpConnection` / `defineOpenapiConnection`
    and `connectAll`: wire an agent into an external MCP server or an OpenAPI
    service and turn each remote operation into a `<connection>__<tool>`
    `defineAction`. Because they register in the unified action registry, June both
    consumes external MCP/OpenAPI (client) AND re-serves them from its own `/mcp`
    (gateway). Web-standard (fetch + JSON-RPC + a minimal OpenAPI subset, zero
    `node:*`); credentials resolve per call, server-side, and never reach the
    model; a down connection is reported, not thrown.
  - `@junejs/server` — `discoverAgent` now scans `connections/*.ts`, calls
    `connectAll`, merges the remote tools into the agent's tool set, and records the
    connection report on `AgentDefinition.connections`.

- [`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2) Thanks [@linyiru](https://github.com/linyiru)! - Make an agent's instructions first-class on the def (no longer silently droppable).

  Previously the system prompt was baked into the `model` at construction
  (`anthropic({ system: buildSystemPrompt(agent) })`), and the runtime def was
  `{ model, tools }` — so instructions were lost at that hand-off unless the caller
  remembered to bake them in.

  Now:

  - `Model` gains an optional `opts.system` (`(msgs, tools, opts?) => reply`) —
    additive, so existing `(msgs, tools)` models and the engine's `model(msgs,
specs)` call are unaffected.
  - `withSystem(model, system)` (`@junejs/core/agent-runtime`) wraps a model to
    carry the system prompt per turn.
  - `AgentDef` / `DoAgentDef` gain `instructions?`; `NativeRuntime` / `MemoryRuntime`
    / `AgentDurableObject` inject it via `withSystem` when building each session —
    single-sourced on the def, impossible to drop. `anthropic()` reads the per-call
    `opts.system` (falling back to its construction-time `system`).

  Bonus: one `anthropic()` model instance can now serve many agents/subagents, each
  supplying its own instructions per turn.

- [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7) Thanks [@linyiru](https://github.com/linyiru)! - Add `@junejs/core/agent-models` — Model-seam provider adapters.

  `anthropic({ model, apiKey?, system?, maxTokens?, thinking? })` turns the
  official `@anthropic-ai/sdk` into the agent runtime's provider-agnostic `Model`
  (streams via `.finalMessage()`; maps the durable transcript ↔ Anthropic Messages,
  folding parallel tool results). The SDK is an **optional peer**, lazy-imported via
  a non-literal specifier, so `@junejs/core` stays installable and typecheckable
  without it and the adapter runs on native _and_ edge (pass `apiKey` on the edge).
  Thinking is off by default until the transcript persists thinking blocks.

- [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e) Thanks [@linyiru](https://github.com/linyiru)! - Add `defineAgent` + directory discovery (agent-runtime build order step 2).

  - `@junejs/core/agent-config` — `defineAgent()` assembles an agent from config +
    tools + skills. `actionToTool()` bridges a `defineAction` into a runtime `Tool`
    (sync ⇒ exactly-once local, async ⇒ at-least-once remote), so an agent's tools
    ARE your server actions — no new tool concept. `readSkillTool` +
    `buildSystemPrompt` give progressive skill disclosure.
  - `@junejs/server/agent-discover` — `discoverAgent(dir)` scans the `agent/`
    directory convention (`agent.ts` + `instructions.md` + `tools/*.ts` +
    `skills/*.md`) into an `AgentDefinition`, ready to mount with
    `createNativeRuntime({ [name]: { model, tools } })`.

- [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090) Thanks [@linyiru](https://github.com/linyiru)! - Add the durable agent-runtime foundation.

  - `@junejs/core/agent-runtime` — a pure (zero `node:*`) durable turn engine and
    its seams: `SessionStore` / `Broadcaster` / `Model`, the `AgentSession` actor
    (turn serialization), and `Runtime`. Durability is log-replay + step-checkpoint
    with session-scoped checkpoint keys; exactly-once for local tool side effects,
    at-least-once for remote/subagent tools. Sibling to `@junejs/core/agent` (the
    `defineAction` registry it consumes), not a replacement.
  - `@junejs/server/agent-native` — the native seam: `NativeRuntime` /
    `createNativeRuntime` over a synchronous SQLite handle (a new
    `openLocalSqliteSync` export from the sqlite driver — the durability
    transaction must be synchronous, so it uses the raw handle rather than the
    async `JuneDb`).

### Patch Changes

- [#40](https://github.com/junebuild/june/pull/40) [`e8eddb5`](https://github.com/junebuild/june/commit/e8eddb53d5111c7d310c2af1f3efd58861780ee4) Thanks [@linyiru](https://github.com/linyiru)! - Edge channel routing: mount an agent's inbound channels (Slack/Crisp webhooks, http)
  on the Worker entry and route each turn into the per-session Durable Object — no
  hand-rolled webhook and no module-global signing-secret setter.

  A Durable Object never sees the Worker's `env` at module scope, and on workerd a
  signing secret exists ONLY in `env` inside an invocation — so a channel that needs a
  secret can't be fully built where it's declared. Until now June's generated worker
  mounted only the chat endpoint, so an edge app hand-rolled the webhook (verify →
  `durableFetch`) and reached for a per-isolate module-global to smuggle the secret in.

  Now:

  - `@junejs/core/agent-config` — a channel module may default-export a `Channel` OR a
    `ChannelFactory = (env) => Channel`. `resolveChannel(c, env)` resolves either;
    `channelDispatch(channels, ctx)` is the dispatch core (`channelFetch` delegates to
    it) so an edge surface can drive it with channels resolved from env. `ChannelContext`
    gains `waitUntil?` — the host passes workerd's `ctx.waitUntil` so a webhook's fast-ACK
    background work (run the turn, post the reply) survives the response instead of being
    killed when the isolate is reclaimed. `crispChannel`/`slackChannel` use it when present
    (native has none and keeps the floating-promise behavior — additive, backward compatible).
  - `@junejs/server/agent-durable` — new `durableChannelSurface(getNamespace, { agentName,
channels, env, waitUntil? })`: resolves factory channels from the worker env (secrets
    bind here), verifies the signature, derives the session, and routes the turn into the
    session DO via `durableFetch`, posting the reply back out on `waitUntil`. The sibling of
    `durableAgentSurface`; a worker composes both.
  - `@junejs/server` discovery resolves a `(env) => Channel` factory with `process.env`, so
    the Shape-B factory form works on native too; a plain `Channel` default export is
    unchanged.

  The `examples/agent-edge` worker now shows a Shape-B crisp channel wired via
  `durableChannelSurface`. Build codegen that generates the whole edge agent entry
  (DO shell + surfaces) remains a separate, later milestone.

- [`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8) Thanks [@linyiru](https://github.com/linyiru)! - Fix: keep shipped source erasable (no TS parameter properties).

  June publishes raw `.ts`, so a consumer's `tsc` type-strips our source under
  their flags — and constructor parameter properties (`constructor(private x: T)`)
  are **not** erasable, breaking `erasableSyntaxOnly` and Node's native
  `--experimental-strip-types`. Rewrote every parameter property to an explicit
  field + assignment (`AgentSession`, the native/DO session stores + runtimes,
  `RedisStore`, juno's `Table`).

  Mechanism so it can't recur: **`erasableSyntaxOnly: true` in `tsconfig.base.json`**
  — the root `typecheck` (which `bun run ci` runs, gating publish) now fails on any
  non-erasable syntax (parameter properties, enums, namespaces, `import =`) across
  every package's src and tests.

- [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` so plain Node can consume `@junejs/core`.

  Node refuses to type-strip `node_modules` `.ts`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so importing `@junejs/core`'s raw
  `.ts` from plain Node failed. `@junejs/core` now builds to `dist/` (ESM JS +
  `.d.ts`) via tsdown and uses **dual-condition exports**: `source`/`bun` still
  serve `src/*.ts` (the zero-build inner loop, Bun, opt-in bundlers), while
  `default`/`types` serve built JS + declarations for Node and external `tsc`.
  `june build` resolves `@junejs/*` via a new `source` condition so it keeps
  bundling source (no dist dependency). Second dogfood packaging fix after erasable;
  `@junejs/core` is the pilot — the remaining packages follow.

- [#42](https://github.com/junebuild/june/pull/42) [`9a5f0fc`](https://github.com/junebuild/june/commit/9a5f0fcb5dd051526c27fb271ee755f16fbfee94) Thanks [@linyiru](https://github.com/linyiru)! - Worker-side app services: `currentServices()` now resolves in loaders, views, and
  actions — the symmetry twin of the services a Durable Object already seeds for its tools.

  `scope.services` (added for the DO) was only seeded at the DO turn entry, so
  `currentServices()` returned `undefined` everywhere the Worker pipeline runs — a route
  `load()`, a view, or a `defineAction` invoked by the UI/`/mcp`. That made the SAME tool
  behave differently depending on who called it (the agent in the DO vs the UI through the
  pipeline).

  Now the app declares services once in `june.config.ts` and the host seeds them at every
  isolate entry, from that isolate's env:

  - `@junejs/core/config` — `ServicesConfig { make(env): unknown; module }` + `defineServices`
    helper + `JuneConfig.services`. `make(env)` builds the bag from the isolate's env (typed
    `any` so the app writes `(env: MyEnv) => …` without a cast); `module` names the file whose
    `services` export IS `make`, so `june build` can import it into the worker (env only exists
    inside an invocation). Same pattern as `dataLayer`.
  - `@junejs/server` — the pipeline seeds `runInScope({ resources, services })`; dev (`createApp`)
    builds the bag from `process.env`; the generated worker binds it from the worker env,
    memoized per isolate; the build imports the app's factory module into the entry (an
    app-relative path is rebased to the entry dir like a route import; a bare specifier is used
    as-is). Re-exports `defineServices`.

  Additive: no `services` declared → `currentServices()` stays `undefined`, byte-identical
  output. The app can single-source the DO too — `services: config.services.make(this.env)` in
  the DO shell.

## 0.1.0-dev.6

### Patch Changes

- [#42](https://github.com/junebuild/june/pull/42) [`9a5f0fc`](https://github.com/junebuild/june/commit/9a5f0fcb5dd051526c27fb271ee755f16fbfee94) Thanks [@linyiru](https://github.com/linyiru)! - Worker-side app services: `currentServices()` now resolves in loaders, views, and
  actions — the symmetry twin of the services a Durable Object already seeds for its tools.

  `scope.services` (added for the DO) was only seeded at the DO turn entry, so
  `currentServices()` returned `undefined` everywhere the Worker pipeline runs — a route
  `load()`, a view, or a `defineAction` invoked by the UI/`/mcp`. That made the SAME tool
  behave differently depending on who called it (the agent in the DO vs the UI through the
  pipeline).

  Now the app declares services once in `june.config.ts` and the host seeds them at every
  isolate entry, from that isolate's env:

  - `@junejs/core/config` — `ServicesConfig { make(env): unknown; module }` + `defineServices`
    helper + `JuneConfig.services`. `make(env)` builds the bag from the isolate's env (typed
    `any` so the app writes `(env: MyEnv) => …` without a cast); `module` names the file whose
    `services` export IS `make`, so `june build` can import it into the worker (env only exists
    inside an invocation). Same pattern as `dataLayer`.
  - `@junejs/server` — the pipeline seeds `runInScope({ resources, services })`; dev (`createApp`)
    builds the bag from `process.env`; the generated worker binds it from the worker env,
    memoized per isolate; the build imports the app's factory module into the entry (an
    app-relative path is rebased to the entry dir like a route import; a bare specifier is used
    as-is). Re-exports `defineServices`.

  Additive: no `services` declared → `currentServices()` stays `undefined`, byte-identical
  output. The app can single-source the DO too — `services: config.services.make(this.env)` in
  the DO shell.

## 0.1.0-dev.5

### Patch Changes

- [#40](https://github.com/junebuild/june/pull/40) [`e8eddb5`](https://github.com/junebuild/june/commit/e8eddb53d5111c7d310c2af1f3efd58861780ee4) Thanks [@linyiru](https://github.com/linyiru)! - Edge channel routing: mount an agent's inbound channels (Slack/Crisp webhooks, http)
  on the Worker entry and route each turn into the per-session Durable Object — no
  hand-rolled webhook and no module-global signing-secret setter.

  A Durable Object never sees the Worker's `env` at module scope, and on workerd a
  signing secret exists ONLY in `env` inside an invocation — so a channel that needs a
  secret can't be fully built where it's declared. Until now June's generated worker
  mounted only the chat endpoint, so an edge app hand-rolled the webhook (verify →
  `durableFetch`) and reached for a per-isolate module-global to smuggle the secret in.

  Now:

  - `@junejs/core/agent-config` — a channel module may default-export a `Channel` OR a
    `ChannelFactory = (env) => Channel`. `resolveChannel(c, env)` resolves either;
    `channelDispatch(channels, ctx)` is the dispatch core (`channelFetch` delegates to
    it) so an edge surface can drive it with channels resolved from env. `ChannelContext`
    gains `waitUntil?` — the host passes workerd's `ctx.waitUntil` so a webhook's fast-ACK
    background work (run the turn, post the reply) survives the response instead of being
    killed when the isolate is reclaimed. `crispChannel`/`slackChannel` use it when present
    (native has none and keeps the floating-promise behavior — additive, backward compatible).
  - `@junejs/server/agent-durable` — new `durableChannelSurface(getNamespace, { agentName,
channels, env, waitUntil? })`: resolves factory channels from the worker env (secrets
    bind here), verifies the signature, derives the session, and routes the turn into the
    session DO via `durableFetch`, posting the reply back out on `waitUntil`. The sibling of
    `durableAgentSurface`; a worker composes both.
  - `@junejs/server` discovery resolves a `(env) => Channel` factory with `process.env`, so
    the Shape-B factory form works on native too; a plain `Channel` default export is
    unchanged.

  The `examples/agent-edge` worker now shows a Shape-B crisp channel wired via
  `durableChannelSurface`. Build codegen that generates the whole edge agent entry
  (DO shell + surfaces) remains a separate, later milestone.

## 0.1.0-dev.4

### Patch Changes

- [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` so plain Node can consume `@junejs/core`.

  Node refuses to type-strip `node_modules` `.ts`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so importing `@junejs/core`'s raw
  `.ts` from plain Node failed. `@junejs/core` now builds to `dist/` (ESM JS +
  `.d.ts`) via tsdown and uses **dual-condition exports**: `source`/`bun` still
  serve `src/*.ts` (the zero-build inner loop, Bun, opt-in bundlers), while
  `default`/`types` serve built JS + declarations for Node and external `tsc`.
  `june build` resolves `@junejs/*` via a new `source` condition so it keeps
  bundling source (no dist dependency). Second dogfood packaging fix after erasable;
  `@junejs/core` is the pilot — the remaining packages follow.

## 0.1.0-dev.3

### Minor Changes

- [`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2) Thanks [@linyiru](https://github.com/linyiru)! - Make an agent's instructions first-class on the def (no longer silently droppable).

  Previously the system prompt was baked into the `model` at construction
  (`anthropic({ system: buildSystemPrompt(agent) })`), and the runtime def was
  `{ model, tools }` — so instructions were lost at that hand-off unless the caller
  remembered to bake them in.

  Now:

  - `Model` gains an optional `opts.system` (`(msgs, tools, opts?) => reply`) —
    additive, so existing `(msgs, tools)` models and the engine's `model(msgs,
specs)` call are unaffected.
  - `withSystem(model, system)` (`@junejs/core/agent-runtime`) wraps a model to
    carry the system prompt per turn.
  - `AgentDef` / `DoAgentDef` gain `instructions?`; `NativeRuntime` / `MemoryRuntime`
    / `AgentDurableObject` inject it via `withSystem` when building each session —
    single-sourced on the def, impossible to drop. `anthropic()` reads the per-call
    `opts.system` (falling back to its construction-time `system`).

  Bonus: one `anthropic()` model instance can now serve many agents/subagents, each
  supplying its own instructions per turn.

## 0.1.0-dev.2

### Minor Changes

- [`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f) Thanks [@linyiru](https://github.com/linyiru)! - Auto-mount the durable agent from `june.config` (build order step 4).

  - `@junejs/core/config`: an `agent.runtime` block (`enabled` / `dir` / `backend` /
    `chat.path` / `channels`), resolved by `resolveAgent`. `channelFetch` now
    returns `Response | null` so it composes as a fall-through surface.
  - `@junejs/server`: the shared render pipeline gains an `agentSurface` slot (runs
    after the static agent surface `/mcp` + discovery, before middleware/routes).
    `mountAgent` gains `surface` — a framework chat endpoint at `chat.path` (POST
    `{message, session?}` → a durable turn) plus the discovered channels. The dev
    server auto-discovers an `agent/` directory and mounts it with an Anthropic
    model: drop an `agent/` folder and `POST /message`, `/channels/*`, and `/mcp`
    (its tools) are all live — no glue.

  Edge (worker.ts + Durable Object routing) is a follow-up; dev auto-mount ships now.

- [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7) Thanks [@linyiru](https://github.com/linyiru)! - Add `@junejs/core/agent-models` — Model-seam provider adapters.

  `anthropic({ model, apiKey?, system?, maxTokens?, thinking? })` turns the
  official `@anthropic-ai/sdk` into the agent runtime's provider-agnostic `Model`
  (streams via `.finalMessage()`; maps the durable transcript ↔ Anthropic Messages,
  folding parallel tool results). The SDK is an **optional peer**, lazy-imported via
  a non-literal specifier, so `@junejs/core` stays installable and typecheckable
  without it and the adapter runs on native _and_ edge (pass `apiKey` on the edge).
  Thinking is off by default until the transcript persists thinking blocks.

## 0.1.0-dev.1

### Patch Changes

- [`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8) Thanks [@linyiru](https://github.com/linyiru)! - Fix: keep shipped source erasable (no TS parameter properties).

  June publishes raw `.ts`, so a consumer's `tsc` type-strips our source under
  their flags — and constructor parameter properties (`constructor(private x: T)`)
  are **not** erasable, breaking `erasableSyntaxOnly` and Node's native
  `--experimental-strip-types`. Rewrote every parameter property to an explicit
  field + assignment (`AgentSession`, the native/DO session stores + runtimes,
  `RedisStore`, juno's `Table`).

  Mechanism so it can't recur: **`erasableSyntaxOnly: true` in `tsconfig.base.json`**
  — the root `typecheck` (which `bun run ci` runs, gating publish) now fails on any
  non-erasable syntax (parameter properties, enums, namespaces, `import =`) across
  every package's src and tests.

## 0.1.0-dev.0

### Minor Changes

- [`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3) Thanks [@linyiru](https://github.com/linyiru)! - Add agent channels — inbound edges (http / slack / crisp).

  - `@junejs/core/agent-config` — the `Channel` / `ChannelContext` contract,
    `defineChannel`, and `channelFetch` (a pure Web-standard router that dispatches
    webhook channels by path and http channels by fall-through). `AgentDefinition`
    now carries `channels`.
  - `@junejs/core/channels` — built-in channel factories: `httpChannel` (POST
    /message + optional /mcp), `slackChannel`, `crispChannel`. Web-standard
    (`crypto.subtle` HMAC verification, `fetch` reply-out — zero `node:*`, edge-
    ready). Secrets are injected as options, so the channel stays portable across
    native and edge; loop guards (bot/operator self-messages) prevent reply loops.
  - `@junejs/server` — `discoverAgent` now scans `channels/*.ts`; new `mountAgent`
    builds a `ChannelContext` whose `run` bridges to a durable turn and returns a
    fetch handler (webhooks + http) plus `startAll` for one-shot channels (cli).

- [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d) Thanks [@linyiru](https://github.com/linyiru)! - Add agent connections — outbound tool sources (the mirror of channels).

  - `@junejs/core/connections` — `defineMcpConnection` / `defineOpenapiConnection`
    and `connectAll`: wire an agent into an external MCP server or an OpenAPI
    service and turn each remote operation into a `<connection>__<tool>`
    `defineAction`. Because they register in the unified action registry, June both
    consumes external MCP/OpenAPI (client) AND re-serves them from its own `/mcp`
    (gateway). Web-standard (fetch + JSON-RPC + a minimal OpenAPI subset, zero
    `node:*`); credentials resolve per call, server-side, and never reach the
    model; a down connection is reported, not thrown.
  - `@junejs/server` — `discoverAgent` now scans `connections/*.ts`, calls
    `connectAll`, merges the remote tools into the agent's tool set, and records the
    connection report on `AgentDefinition.connections`.

- [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e) Thanks [@linyiru](https://github.com/linyiru)! - Add `defineAgent` + directory discovery (agent-runtime build order step 2).

  - `@junejs/core/agent-config` — `defineAgent()` assembles an agent from config +
    tools + skills. `actionToTool()` bridges a `defineAction` into a runtime `Tool`
    (sync ⇒ exactly-once local, async ⇒ at-least-once remote), so an agent's tools
    ARE your server actions — no new tool concept. `readSkillTool` +
    `buildSystemPrompt` give progressive skill disclosure.
  - `@junejs/server/agent-discover` — `discoverAgent(dir)` scans the `agent/`
    directory convention (`agent.ts` + `instructions.md` + `tools/*.ts` +
    `skills/*.md`) into an `AgentDefinition`, ready to mount with
    `createNativeRuntime({ [name]: { model, tools } })`.

- [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090) Thanks [@linyiru](https://github.com/linyiru)! - Add the durable agent-runtime foundation.

  - `@junejs/core/agent-runtime` — a pure (zero `node:*`) durable turn engine and
    its seams: `SessionStore` / `Broadcaster` / `Model`, the `AgentSession` actor
    (turn serialization), and `Runtime`. Durability is log-replay + step-checkpoint
    with session-scoped checkpoint keys; exactly-once for local tool side effects,
    at-least-once for remote/subagent tools. Sibling to `@junejs/core/agent` (the
    `defineAction` registry it consumes), not a replacement.
  - `@junejs/server/agent-native` — the native seam: `NativeRuntime` /
    `createNativeRuntime` over a synchronous SQLite handle (a new
    `openLocalSqliteSync` export from the sqlite driver — the durability
    transaction must be synchronous, so it uses the raw handle rather than the
    async `JuneDb`).

## 0.0.49

### Patch Changes

- [#24](https://github.com/junebuild/june/pull/24) [`a6bc035`](https://github.com/junebuild/june/commit/a6bc0351a7e4c76a4c281b75450ef6250c3734bd) Thanks [@linyiru](https://github.com/linyiru)! - Add a first-class static (GitHub Pages) deploy target.

  - `staticSite()` adapter (`runtime: "static"`): `june build` prerenders every route
    - projection to `dist/static/` (page HTML as `<stem>/index.html`, flat `.md`/`.json`,
      `_june/` assets, `favicon.svg`, `404.html`, `.nojekyll`). `deploy: { target: "static" }`
      resolves it by name — no adapter import. `june deploy` is build-only for this target.
  - `staticPaths` route export: a dynamic catch-all lists the concrete pathnames to
    prerender (locale-expanded), so content-driven routes can ship as static files.
  - `basePath` config: prefixes the framework asset URLs in the rendered document, so a
    site served under a subpath (e.g. a GitHub Pages project path) resolves its assets.

  All additive — `workers()`/`vercel()`/`deno()` and root deploys are unchanged.

## 0.0.48

### Patch Changes

- [#18](https://github.com/junebuild/june/pull/18) [`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c) Thanks [@linyiru](https://github.com/linyiru)! - Configurable content sources: `content.sources` in june.config.ts

  Content no longer has to live under `content/<collection>/`. Config can declare extra source
  directories — including ones outside the app root — that merge into named collections:

  ```ts
  export default defineJune({
    content: {
      sources: [
        { dir: "../docs", collection: "docs" }, // the repo's own docs/, docs-as-code
        { dir: "../schema", collection: "docs", mount: "schema" }, // slugs prefixed schema/…
      ],
    },
  });
  ```

  - Each source scans with the same locale-mirror layout as `content/` (`<dir>/<locale>/…`).
  - `mount` prefixes slugs; a source's root `index.md`/`README.md` becomes the mount's page.
  - A slug collision between sources fails `june gen` loudly, naming both files. A missing
    configured dir is a build error, not a silent skip.
  - Bootstrap-safe: a wrapper-generated config that imports `app/_content.ts` (which only exists
    AFTER the first freeze) self-heals — `june gen` generates the default scan, re-probes the
    config in a fresh subprocess, and regenerates with the sources applied.
  - `june dev` watches configured source dirs (they're outside the app root, invisible to the
    root watcher) and regenerates + restarts on change.

## 0.0.47

### Patch Changes

- [#14](https://github.com/junebuild/june/pull/14) [`8f77b20`](https://github.com/junebuild/june/commit/8f77b201fe15d94f6404372ab0852972272b88e8) Thanks [@linyiru](https://github.com/linyiru)! - fix(client-router): percent-encode the soft-nav title header (non-ASCII titles no longer 500)

  The `fragment` projection put the page title verbatim into the `x-june-title`
  header. HTTP header values are ByteStrings (Latin-1, ≤0xFF), so a non-ASCII
  title — CJK, accents, emoji — threw `TypeError: Cannot convert argument to a
ByteString` at `headers.set`, crashing the whole fragment render with a 500. The
  client router then hit its hard-navigation fallback, so every soft nav to a
  non-ASCII-titled page became a full document reload — the white flash
  `clientRouter` exists to remove (the failure on Node/undici runtimes like
  Vercel's serverless functions; only ASCII-titled pages soft-navigated).

  The server now `encodeURIComponent`s the title before `headers.set`, and the
  three client consumers (morph router, flight router, dev live-reload) decode it
  back with `decodeURIComponent` before assigning `document.title`. ASCII titles
  are unchanged on the wire (`encodeURIComponent("Home") === "Home"`).
