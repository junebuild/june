# @junejs/server

## 1.0.0-dev.15

### Patch Changes

- [#140](https://github.com/junebuild/june/pull/140) [`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828) Thanks [@linyiru](https://github.com/linyiru)! - Agent directory compile — the agent/ convention mounts on the edge ([#139](https://github.com/junebuild/june/issues/139)).

  `discoverAgent` is fs-based and native-only, so every edge consumer hand-assembled what the directory already declares: statically imported tools in a hand-maintained registry, instructions bundled via the wrangler `[[rules]]` Text hack (plus a mirroring vitest md-loader and `readFileSync` in Node scripts — three loaders kept honest only by discipline), manually wired `channelInstructions`, and no skills at all — nothing on the edge synthesized `read_skill`, so authored `skills/*.md` were inert. `june gen` now compiles the directory into `agent/_agent.gen.ts`: static imports for code (tools/channels/connections), prose inlined as string literals (instructions, channel overlays, skills — parsed at init by core's `parseSkill`, so a parser improvement never requires regeneration). Plain erasable TypeScript: bundles under wrangler/Rolldown, imports under bun test and Node type stripping, no loader plugins anywhere. `june gen --check` (and plain `git diff --exit-code` after `june gen`) is the CI staleness gate; `.ts` import extensions are kept when the consumer's tsconfig enables `allowImportingTsExtensions` (Node type-stripping consumers), dropped otherwise.

  One assembly path, two targets — `@junejs/core/agent-config` gains the shared entry points both runtimes go through, so native discovery and the compiled module cannot drift. `AgentModule` is the raw directory shape (channels stay unresolved factories; connections stay definitions — both resolve where the agent actually runs). `assembleAgent(module, env)` is the native side: resolves channel factories, wires connections (`connectAll`), hands everything to `defineAgent` — `discoverAgent` is now a thin fs scan feeding it. `assembleDurable(module)` is the DO side: adapted tools + a synthesized `read_skill`, the system prompt pre-composed with the skill index (`buildSystemPrompt`), channel factories passed through untouched for the DO to resolve with its own env — spread it into `new AgentDurableObject(ctx, { ...assembleDurable(agentModule), model, env, services })`. Skills therefore mount on the Durable Object target for the first time.

  The directory convention grows two pieces the first real consumer already reached for: `channels/<source>.md` is discovered as that channel's `channelInstructions` overlay (native and compiled alike), and skill frontmatter supports `when-to-use` (hyphenated keys now parse; `Skill.whenToUse` rides the prompt's skill index line so the model can decide whether to load a body without spending a tool call). `parseSkill` moved to `@junejs/core/agent-config` — pure, shared by discovery, the compiled module, and tests. `_`-prefixed files under an agent directory are now private by convention (never scanned), which is also what keeps `_agent.gen.ts` itself out of the scan. `examples/agent-edge` is restructured to the compiled pattern: the definition lives in `agent/`, the worker keeps only the DO shell (model + env wiring) and the routed surfaces.

  Follow-up (tracked in [#139](https://github.com/junebuild/june/issues/139)): `june build` sets `WorkerManifest.agentName` and emits the DO class + wrangler `durable_objects`/`migrations` bindings so a June-native app's edge auto-mounts with zero hand-written worker; lazy connection wiring in the DO.

- Updated dependencies [[`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828)]:
  - @junejs/core@0.2.0-dev.33

## 1.0.0-dev.14

### Patch Changes

- [#137](https://github.com/junebuild/june/pull/137) [`17988f3`](https://github.com/junebuild/june/commit/17988f3f6ae2349f0f6c9589b2f8ff68c2c380cd) Thanks [@linyiru](https://github.com/linyiru)! - Channel turn control ([#129](https://github.com/junebuild/june/issues/129)): cancel-and-replace and session reset.

  Cancel-and-replace — a correction sent while a turn is still running supersedes it instead of queuing behind it: the engine polls a per-turn cancel flag at checkpoint boundaries only (between model deltas, between tool calls), so a cancelled turn always leaves a transcript the next turn can build on — a partially-run tool batch is closed with synthetic results, nothing dangles. `start({ replace: true })` / `/turn?replace=1` / a `replace` flag on ChannelContext run variants supersede every unfinished turn (a suspended approval is never cancelled); the turn settles as `{ status: "cancelled" }` and emits `turn.cancelled`. slackChannel adopts it via the opt-in `replaceInFlight` option (message/app_mention only) and renders a superseded stream with a "(superseded)" note.

  Session reset — `ctx.resetSession()` / `POST /reset` / `AgentSession.reset()` terminally retires a session's accumulated history: unfinished turns are superseded, then messages/steps/status are ARCHIVED under a generation counter (the audit trail — never deleted) and live state starts fresh (empty transcript, open initiator seat, any stale suspended park cleared). The session's address never changes; the returned `previousSession` handle (`<session>#g<N>`) names the archived generation. All three SessionStores (Durable Object, native SQLite, memory) implement the archival.

- Updated dependencies [[`17988f3`](https://github.com/junebuild/june/commit/17988f3f6ae2349f0f6c9589b2f8ff68c2c380cd)]:
  - @junejs/core@0.2.0-dev.32

## 1.0.0-dev.13

### Patch Changes

- [#133](https://github.com/junebuild/june/pull/133) [`fba01b9`](https://github.com/junebuild/june/commit/fba01b9060774db087594a7e825e8c4e2ff4a73f) Thanks [@linyiru](https://github.com/linyiru)! - Delivered resume — a HITL continuation now survives the edge waitUntil ceiling, and the
  Approve/Deny buttons can require native confirmation.

  An approved/denied turn's continuation was consumed by the webhook isolate inside
  `ctx.waitUntil`: a continuation running past the post-ACK grace was cancelled silently,
  leaving the prompt stuck on "_Working…_" forever. This completes the delivered-turns story
  (the reply-bearing inbound leg shipped earlier):

  - **`POST /resume?deliver=1`** (AgentDurableObject): applies the answer, 202s, and renders
    the continuation through the source channel's new **`deliverResume()`** under the DO's
    own lifetime. Capability is refused with a **501 before the answer applies** — the
    `DeliverUnsupportedError` contract, so a consumer-side fallback cannot double-answer
    (the engine would 409 the second apply). Engine rejections (403 unauthorized clicker /
    409 stale-or-double click) pass through with their meaning intact.
  - **`ctx.resumeDelivered`** (ChannelContext, provided by `durableChannelSurface`) exposes
    it; **slackChannel** prefers it on Approve/Deny clicks and falls back to `resumeStream` +
    worker-side rendering only on the typed refusal. Rejections keep today's UX: an
    ephemeral note to the clicker, buttons intact for the rightful answerer.
  - **One renderer, two isolates:** the continuation renderer (progress → outcome / failure
    / next approval, updating the prompt message in place) is now a single function shared
    by the worker-side fallback and `deliverResume`. New exported `ResumeDeliveryTarget`.
  - **`approvalConfirm`** (slackChannel, off by default): attaches Slack's native
    confirmation dialog to the Approve/Deny buttons — a modal must be confirmed before the
    interaction fires (the Deny dialog styled danger). Fat-finger protection for approval
    buttons in busy channels.

- Updated dependencies [[`fba01b9`](https://github.com/junebuild/june/commit/fba01b9060774db087594a7e825e8c4e2ff4a73f)]:
  - @junejs/core@0.2.0-dev.30

## 1.0.0-dev.12

### Patch Changes

- [#125](https://github.com/junebuild/june/pull/125) [`ddb8a0c`](https://github.com/junebuild/june/commit/ddb8a0cb1b5b11483c920d3cad5f9d46a1f66a3a) Thanks [@linyiru](https://github.com/linyiru)! - Delivered turns — a reply-bearing turn's rendering now survives the edge waitUntil ceiling.

  A streamed inbound reply (Slack `respondTo` + `stream: true`) used to be rendered by the
  WORKER consuming the DO's SSE turn stream inside `ctx.waitUntil` — so a turn running past
  the post-ACK grace (~30s) was cancelled mid-flight: no `turn.failed`, no `onTurnError`, no
  reply, nothing in the thread (production failure mode: a multi-round Q&A turn ended in
  silence). `runDetached` ([#77](https://github.com/junebuild/june/issues/77)) already rescued _reply-dropping_ shadow turns; this adds the
  reply-bearing sibling:

  - **`ctx.runDelivered`** (ChannelContext, provided by `durableChannelSurface`): start the
    turn and have the TURN'S HOST render the reply — 202 on acceptance, nothing held open.
  - **`POST /turn?deliver=1`** (AgentDurableObject): renders the turn's event stream through
    the source channel's own `deliver()` (the P4 §9 renderer) from INSIDE the DO, under the
    DO's own lifetime. Requires the channel wired via `DoAgentDef.channels`; refuses with a
    **501 before starting the turn** otherwise.
  - **`DeliverUnsupportedError`** (agent-config): the surface maps that pre-start 501 to this
    typed rejection — the one error a channel may answer with a consumer-side rendering
    fallback (`ctx.runStream`) without double-running the turn.
  - **slackChannel** now prefers `ctx.runDelivered` on its streaming `respondTo` path and
    falls back to worker-side rendering only on `DeliverUnsupportedError`.

  Adopting on the durable edge: pass the same channel factories to the DO —
  `new AgentDurableObject(ctx, { …, channels: [slackChannel], env })` — or the channel falls
  back to the old (ceiling-bounded) worker-side rendering.

- Updated dependencies [[`ddb8a0c`](https://github.com/junebuild/june/commit/ddb8a0cb1b5b11483c920d3cad5f9d46a1f66a3a)]:
  - @junejs/core@0.2.0-dev.27

## 1.0.0-dev.11

### Patch Changes

- [#123](https://github.com/junebuild/june/pull/123) [`e84546c`](https://github.com/junebuild/june/commit/e84546c8e14b87a8cee4a004d67764bc6b17c806) Thanks [@linyiru](https://github.com/linyiru)! - Isolate-scoped state: `isolateLocal`, and the services bag is no longer rebuilt per request.

  June resolves ChannelFactories and the `services` provider **per request** — a
  Worker has no `env` at module top-level, so the host must call them inside an
  invocation. The consequence was a footgun: anything they construct, including a
  cache, is rebuilt per request, so an app that "added a 5-minute cache" silently
  never got a hit. The fix is in two halves.

  - **`isolateLocal(key, make)`** (`@junejs/db`) — the sibling of `requestLocal`,
    for state that must OUTLIVE a request: a connection pool, a token cache, a
    compiled index. Keyed off `globalThis` (the same trick `ACTION_REGISTRY`
    uses), so duplicate module instances from workspace symlinks share one value
    instead of splitting the cache in two. Values are never evicted — anything
    with a bound must bound itself.
  - **`durableChannelSurface({ services })` is memoized per `env`** — resolved once
    per isolate rather than once per surface construction, so clients and caches in
    the bag survive across webhooks. The contract is unchanged (the provider must
    be a function of `env` alone); a fresh `env` object still gets a fresh bag, and
    a non-object `env` skips memoization.

- Updated dependencies [[`e84546c`](https://github.com/junebuild/june/commit/e84546c8e14b87a8cee4a004d67764bc6b17c806)]:
  - @junejs/db@0.1.0-dev.2

## 1.0.0-dev.10

### Minor Changes

- [#121](https://github.com/junebuild/june/pull/121) [`fea4078`](https://github.com/junebuild/june/commit/fea407877de98adda39c2f277d45157ea9a8d6f0) Thanks [@linyiru](https://github.com/linyiru)! - Actions gain identity + standards-aligned metadata; connections gain per-call identity.

  - `defineAction({ requiresPrincipal })`: one identity gate, enforced on EVERY
    dispatch path — `invokeAction` (UI POST, /mcp tools/call) rejects when
    `ctx.user` is absent, `actionToTool` copies the flag so the turn engine hides
    the bridged tool from anonymous turns entirely, and the Flight server
    reference registers as a fail-closed wrapper (an RSC dispatch that doesn't
    thread an identified ActionContext throws).
  - `createPipeline({ identity })` (@junejs/june): the auth integration's seam —
    resolve the request's principal once and the built-in `/mcp` mount dispatches
    with it, so `requiresPrincipal` actions and per-call connection `auth(ctx)`
    work end to end on that surface. Absent → anonymous (gated actions reject).
  - `actionToTool` now threads the turn's identity: `ToolContext.principal` maps
    onto `ActionContext.user` — the same field a UI or /mcp dispatch carries — so
    one authorization check inside an action covers every path (this was
    previously an empty `{}` with a "threads real identity later" comment).
  - `defineAction({ annotations })`: MCP ToolAnnotations (2025-11-25 —
    readOnlyHint/destructiveHint/idempotentHint/openWorldHint/title). Advisory
    metadata; June's /mcp gateway re-serves them so MCP clients can drive
    permission UX. A connection carries a remote MCP tool's annotations through
    unchanged (gateway fidelity).
  - Connection `auth` is now `(ctx?: ActionContext) => {token}` — resolved per
    call with the caller's identity, so an auth can mint per-tenant short-lived
    credentials instead of holding one static key. Called without ctx at
    discovery time (initialize/tools/list/OpenAPI doc fetch); zero-arg auths are
    unaffected (backward compatible).
  - Connection `requiresPrincipal` stamps every action the connection exposes —
    a tenant-scoped remote's tools are invisible on anonymous turns.

### Patch Changes

- Updated dependencies [[`fea4078`](https://github.com/junebuild/june/commit/fea407877de98adda39c2f277d45157ea9a8d6f0)]:
  - @junejs/core@0.2.0-dev.26
  - @junejs/db@0.0.34-dev.1

## 0.1.2-dev.9

### Patch Changes

- [#99](https://github.com/junebuild/june/pull/99) [`d323e45`](https://github.com/junebuild/june/commit/d323e458f5889b9179b137425af2ae8718b24d6e) Thanks [@linyiru](https://github.com/linyiru)! - `@junejs/core` is now a peerDependency of `@junejs/server` ([#94](https://github.com/junebuild/june/issues/94)) — the app's single core resolution always wins, so a package manager can no longer nest a second, older core copy under server (the version-skew class that surfaced in production as a mid-turn `sink.emit is not a function`).

  Belt-and-braces: core exports `RUNTIME_API_VERSION`, and server asserts it at surface construction (`AgentDurableObject`, `NativeRuntime`) — a skewed tree now fails at power-on with both versions named instead of mid-turn.

  Migration: npm ≥7 / bun / pnpm auto-install required peers, so most apps need no change; if your tool doesn't, add `@junejs/core` to the app's dependencies (it almost certainly already is).

- Updated dependencies [[`d323e45`](https://github.com/junebuild/june/commit/d323e458f5889b9179b137425af2ae8718b24d6e)]:
  - @junejs/core@0.1.1-dev.16

## 0.1.2-dev.8

### Patch Changes

- [#97](https://github.com/junebuild/june/pull/97) [`2e4cc43`](https://github.com/junebuild/june/commit/2e4cc43cabe64bc569c9f6039ffc6f68765c328f) Thanks [@linyiru](https://github.com/linyiru)! - Turn failures carry the full error, serialized at the throw site ([#96](https://github.com/junebuild/june/issues/96)):

  - `turn.failed` (and `TurnResult`'s failed arm) now carry `TurnError` — `{ message, stack?, causeChain? }` — plus `phase` ("model" | "tool") and `step` (the in-flight step id, e.g. `model:3` / `tool:call_7`) naming what was running when the turn died. Non-Error throwables keep their JSON shape instead of collapsing to "[object Object]".
  - `onTurnError` receives the extended payload unchanged from the failure site — for a detached turn this hook is the only failure-surfacing path, so nothing is flattened before it fires. Backwards-compatible: all new fields are additions.
  - The DO's default failure log (wrangler tail) prints the step and the real stack trace (plus a `caused by:` chain) instead of the message alone.
  - The SSE-collapsing paths (`sseTurnFinalText`, the channel non-streamed reply) rethrow with the full `TurnError` as `cause`.
  - New export: `serializeTurnError(err)` (cycle-capped `cause` walk).

- Updated dependencies [[`2e4cc43`](https://github.com/junebuild/june/commit/2e4cc43cabe64bc569c9f6039ffc6f68765c328f)]:
  - @junejs/core@0.1.1-dev.15

## 0.1.2-dev.7

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
- Updated dependencies [[`09d9901`](https://github.com/junebuild/june/commit/09d99010df4865fed38cfa64c79efeccb200c0b0)]:
  - @junejs/core@0.1.1-dev.14

## 0.1.2-dev.6

### Patch Changes

- [#84](https://github.com/junebuild/june/pull/84) [`c12b786`](https://github.com/junebuild/june/commit/c12b78696152545bd53ce52dec9a00254e9cd3a8) Thanks [@linyiru](https://github.com/linyiru)! - The external session key now reaches the turn scope on the Durable Object
  target ([#75](https://github.com/junebuild/june/issues/75)): `durableFetch` stamps the key on an `x-june-session` header
  (exported as `SESSION_HEADER`), and `AgentDurableObject` resolves its
  session lazily from it — first keyed request wins, the key is persisted in
  the DO's storage so it survives hibernation/eviction, and key-less paths
  fall back to the persisted key. Tools finally see the real conversation as
  `ctx.sessionId` instead of the literal `"self"`. A key that contradicts the
  object's identity is refused loudly (409) rather than silently corrupting
  per-session data. Backward compatible: with no key anywhere, the session id
  stays `"self"`. The direct API gains `turn({ session })` for custom shells.

## 0.1.2-dev.5

### Patch Changes

- [#82](https://github.com/junebuild/june/pull/82) [`f08d622`](https://github.com/junebuild/june/commit/f08d622d24f21f2529a9cd784318070122a17d54) Thanks [@linyiru](https://github.com/linyiru)! - Failed turns are no longer silent on the edge ([#76](https://github.com/junebuild/june/issues/76)): AgentDurableObject now
  `console.error`s every `turn.failed` by default — visible in `wrangler tail`,
  where a turn that dies after the fast-ACK previously had no observable surface
  at all. A new `onTurnError` hook on `DoAgentDef` lets the app take over
  reporting (Sentry, a ledger, …); if the hook itself throws, the default log
  fires anyway, so a failure can never go unreported. One seam on the session
  sink covers every turn path: `turn()`, `POST /turn`, and `POST /resume`.

## 0.1.2-dev.4

### Patch Changes

- Suspend/resume (HITL) + proactive turns — RFC P3, P3b, P4 (see docs/rfc-turn-as-live-process.md). The turn-as-live-process RFC is now fully shipped.

  - **P3 — suspend / resume (HITL)**: a tool pauses a turn for human input with `ctx.requestInput({ id, prompt, answererId? })`; the turn parks durably as a consumable `suspended` checkpoint (the DO can hibernate) and emits `input.requested`. `AgentSession.resume(turnId, inputId, input, { by })` validates the target + inputId and enforces the answerer (default-deny when `answererId` is set), then replays the same durable step-checkpoint machine — exactly-once, now "a step whose result comes from a human". The DO gains a streamed `POST /resume`; `/turn` and `/resume` map suspension conflicts to 4xx (403 unauthorized answerer, 409 wrong/parked turn) instead of crashing.
  - **P3b — Slack HITL**: `input.requested` renders Approve/Deny Block Kit buttons (`june_input:*`); a signed `block_actions` interaction routes to `resume` with the clicker's verified id. A rejected click (wrong/stale answerer) leaves the buttons intact and tells only the clicker (ephemeral); HITL works in both stream and post-once render modes; dead ends (unusable payload, no resumeStream) surface via `onError`.
  - **P4 — proactive / agent-initiated**: a distinct `trigger`-role `Msg` opens a proactive turn attributed to `by` (a schedule, another channel, the agent), mapped to a user message at the model adapter (no new provider role). `channel.deliver(target, events)` renders a turn's stream to a `DeliveryTarget` with no inbound event; `receive(channel, ctx, { seed, target, trigger, session })` starts the proactive turn and wires its stream to `deliver`. The trigger threads through the edge (`serializeTurn` → DO `/turn` → `session.start`).

- Updated dependencies []:
  - @junejs/core@0.1.1-dev.8

## 0.1.2-dev.3

### Patch Changes

- The turn as a live process — P1 (see docs/rfc-turn-as-live-process.md). A turn is no longer only `Promise<string>`; it emits a durable, observable stream of typed events.

  - **TurnEvent bus**: `runTurn` emits structured events (`turn.started`, `action.requested`/`completed`, `message.completed`, `turn.completed`/`failed`) at its step boundaries; `Broadcaster.publish(turnId)` is now `EventSink.emit(TurnEvent)`.
  - **`start` / `result` / `observe`**: `AgentSession.start(input) => { turnId }` (non-blocking) + `result(turnId) => Promise<TurnResult>` (completed | failed); `observe(cb, { turnId?, replay? })` folds the structural prefix from the durable log for a late/reconnecting subscriber, then goes live. `turn() => Promise<string>` stays as the non-interactive convenience.
  - **SSE transport**: the Durable Object `/turn` streams TurnEvents as `text/event-stream` (with `no-store` + a `:hb` heartbeat); `durableAgentSurface` pipes it through on `Accept: text/event-stream` (live chat) or collapses to `{ text }`.
  - **Channel render**: `ChannelContext.runStream` exposes the live TurnEvent stream; `slackChannel({ stream: true })` posts "Thinking…" then edits that one message in place (tool status → final answer). Exported primitives: `sseTurnEvents`, `sseTurnFinalText`.

  Token-level streaming into the same message (`reasoning.delta`/`message.delta`), suspend/resume (HITL), and proactive turns are the following phases (P2–P4).

- Updated dependencies []:
  - @junejs/core@0.1.1-dev.5

## 0.1.2-dev.2

### Patch Changes

- Channel hooks round 2 — less transport glue in a thin wrapper:

  - **`on` (per-kind observers)**: `slackChannel({ on: { reaction_added: (event, ctx) => … } })` — a typed handler that fires only for its kind, only when a normalized event exists (post bot/loop guards), so `event` is non-optional and there's no `event.kind` demux or `event?` guard. Coexists with `onEvent` (the raw firehose). `crispChannel` gets `on.message`.
  - **`ctx.services` (hook-level DI)**: channel hooks run at the edge, outside the Durable Object, so they can't read the DO's `currentServices()`. `durableChannelSurface({ services: (env) => makeServices(env) })` (and `mountAgent({ services })`) resolve the SAME factory and expose it as `ctx.services` — one DI story for edge and turn; a hook writes via `ctx.services.feedback.record(…)` instead of re-plumbing bindings.
  - **Derived `events`**: when omitted, the Slack subscribe list is derived from `respondTo` + `on` keys (union) so kinds aren't written twice and can't drift; pass `events` explicitly to override. The friendly default (message + app_mention) still applies when no intent is expressed.

- Updated dependencies []:
  - @junejs/core@0.1.1-dev.4

## 0.1.2-dev.1

### Patch Changes

- Channel turn-control + source-aware prompts, so a shared agent needs far less custom channel code:

  - **`respondTo`** (slackChannel): per-KIND control over which subscribed events drive a turn+reply; the rest reach only `onEvent`. e.g. `events:["app_mention","reaction_added"], respondTo:["app_mention"]` runs a turn for a mention but treats a reaction as a deterministic observe (no LLM).
  - **`channelInstructions`** (defineAgent / DoAgentDef): per-source system overlays. When a turn's `InboundEvent.source` matches a key, that text is appended to the system prompt — a shared agent branches on the real, unforgeable source instead of a userText marker. `withSystem` now appends a per-turn overlay to the base instead of dropping it.
  - **AgentDurableObject `channels` + `env`**: builds a mounted channel's capability tools inside the DO (a tool's run closure can't cross the worker→DO RPC) — the edge equivalent of `defineAgent` merging `channel.tools()` on native.
  - **Exported primitives**: `verifySlackSignature`, `verifyCrispSignature`, `normalizeSlackEvent`, `tryParseJson`, `timestampFresh` — a hand-rolled channel reuses the crypto/normalization instead of re-implementing it.

- Updated dependencies []:
  - @junejs/core@0.1.1-dev.3

## 0.1.2-dev.0

### Patch Changes

- Channel capabilities: agents can now read and act on chat platforms, not just echo text.

  - `InboundEvent` normalized envelope threaded into turn + tool context (`ToolContext.event`), carried end-to-end over the durable `/turn` RPC and the native path.
  - Channels can contribute outbound capability tools (`Channel.tools`), merged into `agent.tools` by `defineAgent` (which now throws on a duplicate tool name).
  - Slack: `slack_read_thread`, `slack_list_reactions`, `slack_resolve_user`, `slack_add_reaction`; `message` / `app_mention` / `reaction_added` / `reaction_removed` event turns (reactions opt-in via `events`, `botUserId` loop guard).
  - Crisp: normalized envelope + `crisp_read_conversation`; empty replies no longer posted.
  - Cross-channel safety: tools default their target from the current event only when `event.source` matches. Durable `/turn` serialization drops an unserializable `event.raw` instead of failing the turn.

- Updated dependencies []:
  - @junejs/core@0.1.1-dev.0
  - @junejs/db@0.0.34-dev.0

## 0.1.1

### Patch Changes

- [#46](https://github.com/junebuild/june/pull/46) [`7861c11`](https://github.com/junebuild/june/commit/7861c115058bc15898816652f1b795b58dd325a0) Thanks [@linyiru](https://github.com/linyiru)! - DO seam: constrain the structural `SqlStorage`/`SqlStorageCursor` row generic so
  `this.ctx` from `@cloudflare/workers-types` assigns directly — no cast in a DO shell.

  `agent-durable.ts` describes the Cloudflare surface with minimal structural interfaces
  (no `@cloudflare/workers-types` dep). Its `exec<T = Record<string, unknown>>` left `T`
  unconstrained, while workers-types uses `exec<T extends Record<string, SqlStorageValue>>`.
  An unconstrained `T` promises `toArray(): T[]` for arbitrary `T`, which workerd's
  cursor — only ever `Record<string, SqlStorageValue>` rows — cannot satisfy, so passing
  `this.ctx.storage` into `AgentDurableObject`/`DoSessionStore` failed to typecheck and each
  consumer paid the same `as unknown as JuneDoState` tax.

  Fix: mirror the constraint STRUCTURALLY (still no workers-types import). Add
  `export type SqlStorageValue = ArrayBuffer | string | number | null` and constrain both
  `exec` and `SqlStorageCursor` to `T extends Record<string, SqlStorageValue>`. The two
  `exec` signatures now unify, so `this.ctx` is assignable with no cast. Backward compatible:
  existing typed calls (`exec<{ body: string }>`) and bare side-effect calls still compile,
  and the constraint correctly rejects impossible row types (e.g. a `Date` column). Changing
  only the default — not the constraint — does NOT fix this; the constraint is load-bearing.

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

- [`e70960d`](https://github.com/junebuild/june/commit/e70960d19ac1f70da54e22f666891ce5b1c4ba77) Thanks [@linyiru](https://github.com/linyiru)! - Add the Durable Object edge target + selectable agent-runtime backends.

  - `@junejs/server/agent-durable` — the first-class edge seam. `DoSessionStore`
    runs over a Durable Object's synchronous `ctx.storage.sql` +
    `transactionSync`, so the exact durability contract (exactly-once) holds on the
    edge. One DO = one session, so the store needs no `session_id`. `AgentDurableObject`
    runs a durable turn inside a DO (POST /turn, GET /transcript); `durableFetch`
    routes a request to a session's DO by `idFromName`. Follows the no-external-
    types discipline — the Cloudflare surface is minimal structural interfaces and
    there is NO `cloudflare:workers` import, so it typechecks + unit-tests under Bun
    against a fake `SqlStorage`. The app supplies the 4-line `extends DurableObject`
    shell in its worker.
  - The Durable Object is **optional**. `createAgentRuntime(agents, { backend })`
    selects the in-process backend — `native` (SQLite, durable on a long-running
    host; the default no-DO answer) or `memory` (ephemeral, no disk — dev/tests/
    stateless previews via the new `MemoryRuntime`). `durable` is the DO target the
    worker constructs (createAgentRuntime throws with guidance rather than pretend).

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

- [#38](https://github.com/junebuild/june/pull/38) [`9950e93`](https://github.com/junebuild/june/commit/9950e93ec899bc117682d2c73169176bb0f195fa) Thanks [@linyiru](https://github.com/linyiru)! - Make the Durable Object a first-class scope root, so tools reach ambient `db` and
  app-defined services WITHOUT a module-global setter or `env` on ctx.

  A DO is a separate isolate from the Worker entry, reached by RPC — so the
  pipeline's request scope (and its ambient `db`/`kv`/`blob`) never crossed into it.
  That left tools running in a DO with only `ToolContext` and no way to reach
  resources June doesn't model (Vectorize, Workers AI, an app ledger, a signing
  secret), forcing apps to a per-isolate module-global setter that is null if
  injected in the wrong isolate.

  Now:

  - `@junejs/db` — `RequestScope` gains an app-defined `services?: unknown` bag
    (opaque here; the app types it at the read), seeded by the host at each isolate
    entry from that isolate's env. New `currentServices<T>()` reads it (soft —
    returns `undefined` outside a scope / when unseeded, so the app's own typed
    accessor decides whether a missing service throws). Re-exported from
    `@junejs/server`.
  - `@junejs/server/agent-durable` — `DoAgentDef` gains `resources?` and `services?`.
    The app builds them from the DO's own env in the DO constructor (where env
    lives), and `AgentDurableObject` runs every turn inside `runInScope(...)` seeded
    with them. So a tool reads ambient `db` (from `resources`) and `currentServices()`
    exactly as a route loader does. `locals` is fresh per turn — a fresh scope per
    turn means per-turn state (e.g. Juno's batch-loader registry) can't leak across
    turns on a long-lived DO. Additive: a def without `resources`/`services` runs in
    an empty scope, unchanged.

  This also fixes a latent gap: ambient `db` was previously unavailable (it threw)
  inside a DO tool, since no scope was ever entered there.

- [`af8c0a7`](https://github.com/junebuild/june/commit/af8c0a7b34f90b113b54d9230806612f5d7d89e3) Thanks [@linyiru](https://github.com/linyiru)! - Route the durable agent chat endpoint to a per-session Durable Object on the edge.

  `durableAgentSurface(getNamespace, { agentName, chatPath })` forwards `POST
<chat.path>` to the session's DO (`env.AGENT`, addressed by `idFromName`), and
  `createWorker` mounts it when `manifest.agentName` is set and the runtime is
  enabled — inert (falls through) when no DO is bound, so existing workers are
  unaffected. Tested with a fake DurableObjectNamespace (the repo's fake-bindings
  discipline; the DO logic is covered by the fake-SqlStorage tests).

  Follow-up to make it live on a real deploy: the build must discover the agent/
  directory to set `manifest.agentName`, bundle the app's `JuneAgentDO`, and emit
  the wrangler DO binding + migration. Channel webhooks on the edge (session from
  the platform payload) also remain a follow-up.

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

- [#37](https://github.com/junebuild/june/pull/37) [`9dc99d5`](https://github.com/junebuild/june/commit/9dc99d5bd0851bdd1aa261311ce108e697b85b3f) Thanks [@linyiru](https://github.com/linyiru)! - Serve `public/` static files verbatim — dev and every deploy target.

  Drop a file in the app-root `public/` directory and it is served at the matching
  URL (`public/logo.svg` → `/logo.svg`), passthrough only: no content-hashing, no
  optimization (that stays a future image service's job). Zero config.

  - New internal `static-files` module (not a public entrypoint): `contentTypeFor`
    (extension → MIME) and `safeRelativePath` (a pure, traversal-safe path cleaner —
    rejects `..`, backslashes, NUL, and malformed encoding). No `node:*`, so the
    worker bundle imports it too.
  - Dev (`app.ts`): serves `public/` off disk before the render pipeline, so a
    public file shadows a same-path route exactly as it does when deployed.
  - Build (`build.ts`): copies `public/**` into `dist/assets/**`, skipping the
    reserved `_june/` segment (framework assets) with a warning; the copied paths
    are threaded to adapters via a new `AdapterEmitContext.publicFiles`.
  - Adapters: **Cloudflare** and **static** serve them via the whole-`assets/`
    tier (unchanged). **Vercel** places `publicFiles` on the Build Output `static/`
    tier (prerendered pages stay on the SSR function). **Deno** (`withDenoAssets`)
    now serves any co-located `assets/` file, not just `/_june/*`. Public files are
    `cache-control: must-revalidate` (not `immutable` — they are not hashed).

  See `docs/static-files.md`.

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

- Updated dependencies [[`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f), [`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`9950e93`](https://github.com/junebuild/june/commit/9950e93ec899bc117682d2c73169176bb0f195fa), [`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2), [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090), [`e8eddb5`](https://github.com/junebuild/june/commit/e8eddb53d5111c7d310c2af1f3efd58861780ee4), [`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8), [`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd), [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc), [`9a5f0fc`](https://github.com/junebuild/june/commit/9a5f0fcb5dd051526c27fb271ee755f16fbfee94)]:
  - @junejs/core@0.1.0
  - @junejs/db@0.0.33

## 0.1.0-dev.8

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

- Updated dependencies [[`9a5f0fc`](https://github.com/junebuild/june/commit/9a5f0fcb5dd051526c27fb271ee755f16fbfee94)]:
  - @junejs/core@0.1.0-dev.6

## 0.1.0-dev.7

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

- Updated dependencies [[`e8eddb5`](https://github.com/junebuild/june/commit/e8eddb53d5111c7d310c2af1f3efd58861780ee4)]:
  - @junejs/core@0.1.0-dev.5

## 0.1.0-dev.6

### Patch Changes

- [#38](https://github.com/junebuild/june/pull/38) [`9950e93`](https://github.com/junebuild/june/commit/9950e93ec899bc117682d2c73169176bb0f195fa) Thanks [@linyiru](https://github.com/linyiru)! - Make the Durable Object a first-class scope root, so tools reach ambient `db` and
  app-defined services WITHOUT a module-global setter or `env` on ctx.

  A DO is a separate isolate from the Worker entry, reached by RPC — so the
  pipeline's request scope (and its ambient `db`/`kv`/`blob`) never crossed into it.
  That left tools running in a DO with only `ToolContext` and no way to reach
  resources June doesn't model (Vectorize, Workers AI, an app ledger, a signing
  secret), forcing apps to a per-isolate module-global setter that is null if
  injected in the wrong isolate.

  Now:

  - `@junejs/db` — `RequestScope` gains an app-defined `services?: unknown` bag
    (opaque here; the app types it at the read), seeded by the host at each isolate
    entry from that isolate's env. New `currentServices<T>()` reads it (soft —
    returns `undefined` outside a scope / when unseeded, so the app's own typed
    accessor decides whether a missing service throws). Re-exported from
    `@junejs/server`.
  - `@junejs/server/agent-durable` — `DoAgentDef` gains `resources?` and `services?`.
    The app builds them from the DO's own env in the DO constructor (where env
    lives), and `AgentDurableObject` runs every turn inside `runInScope(...)` seeded
    with them. So a tool reads ambient `db` (from `resources`) and `currentServices()`
    exactly as a route loader does. `locals` is fresh per turn — a fresh scope per
    turn means per-turn state (e.g. Juno's batch-loader registry) can't leak across
    turns on a long-lived DO. Additive: a def without `resources`/`services` runs in
    an empty scope, unchanged.

  This also fixes a latent gap: ambient `db` was previously unavailable (it threw)
  inside a DO tool, since no scope was ever entered there.

- [#37](https://github.com/junebuild/june/pull/37) [`9dc99d5`](https://github.com/junebuild/june/commit/9dc99d5bd0851bdd1aa261311ce108e697b85b3f) Thanks [@linyiru](https://github.com/linyiru)! - Serve `public/` static files verbatim — dev and every deploy target.

  Drop a file in the app-root `public/` directory and it is served at the matching
  URL (`public/logo.svg` → `/logo.svg`), passthrough only: no content-hashing, no
  optimization (that stays a future image service's job). Zero config.

  - New internal `static-files` module (not a public entrypoint): `contentTypeFor`
    (extension → MIME) and `safeRelativePath` (a pure, traversal-safe path cleaner —
    rejects `..`, backslashes, NUL, and malformed encoding). No `node:*`, so the
    worker bundle imports it too.
  - Dev (`app.ts`): serves `public/` off disk before the render pipeline, so a
    public file shadows a same-path route exactly as it does when deployed.
  - Build (`build.ts`): copies `public/**` into `dist/assets/**`, skipping the
    reserved `_june/` segment (framework assets) with a warning; the copied paths
    are threaded to adapters via a new `AdapterEmitContext.publicFiles`.
  - Adapters: **Cloudflare** and **static** serve them via the whole-`assets/`
    tier (unchanged). **Vercel** places `publicFiles` on the Build Output `static/`
    tier (prerendered pages stay on the SSR function). **Deno** (`withDenoAssets`)
    now serves any co-located `assets/` file, not just `/_june/*`. Public files are
    `cache-control: must-revalidate` (not `immutable` — they are not hashed).

  See `docs/static-files.md`.

- Updated dependencies [[`9950e93`](https://github.com/junebuild/june/commit/9950e93ec899bc117682d2c73169176bb0f195fa)]:
  - @junejs/db@0.0.33-dev.2

## 0.1.0-dev.5

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

- Updated dependencies [[`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd), [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc)]:
  - @junejs/db@0.0.33-dev.1
  - @junejs/core@0.1.0-dev.4

## 0.1.0-dev.4

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

### Patch Changes

- Updated dependencies [[`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2)]:
  - @junejs/core@0.1.0-dev.3

## 0.1.0-dev.3

### Patch Changes

- [`af8c0a7`](https://github.com/junebuild/june/commit/af8c0a7b34f90b113b54d9230806612f5d7d89e3) Thanks [@linyiru](https://github.com/linyiru)! - Route the durable agent chat endpoint to a per-session Durable Object on the edge.

  `durableAgentSurface(getNamespace, { agentName, chatPath })` forwards `POST
<chat.path>` to the session's DO (`env.AGENT`, addressed by `idFromName`), and
  `createWorker` mounts it when `manifest.agentName` is set and the runtime is
  enabled — inert (falls through) when no DO is bound, so existing workers are
  unaffected. Tested with a fake DurableObjectNamespace (the repo's fake-bindings
  discipline; the DO logic is covered by the fake-SqlStorage tests).

  Follow-up to make it live on a real deploy: the build must discover the agent/
  directory to set `manifest.agentName`, bundle the app's `JuneAgentDO`, and emit
  the wrangler DO binding + migration. Channel webhooks on the edge (session from
  the platform payload) also remain a follow-up.

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

### Patch Changes

- Updated dependencies [[`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f), [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7)]:
  - @junejs/core@0.1.0-dev.2

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

- Updated dependencies [[`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8)]:
  - @junejs/core@0.1.0-dev.1

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

- [`e70960d`](https://github.com/junebuild/june/commit/e70960d19ac1f70da54e22f666891ce5b1c4ba77) Thanks [@linyiru](https://github.com/linyiru)! - Add the Durable Object edge target + selectable agent-runtime backends.

  - `@junejs/server/agent-durable` — the first-class edge seam. `DoSessionStore`
    runs over a Durable Object's synchronous `ctx.storage.sql` +
    `transactionSync`, so the exact durability contract (exactly-once) holds on the
    edge. One DO = one session, so the store needs no `session_id`. `AgentDurableObject`
    runs a durable turn inside a DO (POST /turn, GET /transcript); `durableFetch`
    routes a request to a session's DO by `idFromName`. Follows the no-external-
    types discipline — the Cloudflare surface is minimal structural interfaces and
    there is NO `cloudflare:workers` import, so it typechecks + unit-tests under Bun
    against a fake `SqlStorage`. The app supplies the 4-line `extends DurableObject`
    shell in its worker.
  - The Durable Object is **optional**. `createAgentRuntime(agents, { backend })`
    selects the in-process backend — `native` (SQLite, durable on a long-running
    host; the default no-DO answer) or `memory` (ephemeral, no disk — dev/tests/
    stateless previews via the new `MemoryRuntime`). `durable` is the DO target the
    worker constructs (createAgentRuntime throws with guidance rather than pretend).

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

- Updated dependencies [[`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090)]:
  - @junejs/core@0.1.0-dev.0
  - @junejs/db@0.0.33-dev.0

## 0.0.59

### Patch Changes

- [#34](https://github.com/junebuild/june/pull/34) [`b0e7f77`](https://github.com/junebuild/june/commit/b0e7f77b2d8317e5e15c6a3b5b8069d9bfdf0b5f) Thanks [@linyiru](https://github.com/linyiru)! - Resolve `deploy.target` to the built-in adapter at BUILD time (not just "static")

  The build only special-cased `deploy.target === "static"` (→ `staticSite()`); every other
  target — including `"vercel"` and `"deno"` — silently fell back to `workers()`. So a purely
  DECLARATIVE config that can't express a `vercel()` call (e.g. `kura.toml`'s `[deploy] target =
"vercel"`) was packaged as a Cloudflare Workers bundle instead of a Vercel one. (`deploy.ts`
  already resolved all four targets by name for the deploy VERB, so build and deploy disagreed.)

  The adapter resolution is now `resolveDeployAdapter(deploy)` (exported): an explicit `adapter`
  instance still wins, otherwise the `target` name selects the matching built-in —
  `static`/`vercel`/`deno`/`workers` — defaulting to `workers()`. This puts build in lockstep with
  `deploy.ts`, so `kura.toml` (or any string-only config) can target Vercel/Deno without importing
  the adapter factory. `vercel()`/`deno()` use their default opts (runtime/regions, org/app aren't
  carried on `JuneConfig.deploy` yet). Passing an `adapter` instance is unchanged.

## 0.0.58

### Patch Changes

- [#32](https://github.com/junebuild/june/pull/32) [`c15f14e`](https://github.com/junebuild/june/commit/c15f14ecb82f1646fda190c6d2bc8648944b84b3) Thanks [@linyiru](https://github.com/linyiru)! - fix(build): seed the config's app/\_content imports so external-only content.sources bootstraps

  A docs-as-code app keeps ALL content in external `content.sources` (e.g. the repo's own
  `../docs`) with NO local `content/`. On a FRESH build the generated config imports
  `app/_content.ts` (`import { DOCS } from "./app/_content"`), which the first freeze creates —
  so `generateContent`'s bootstrap runs its two-pass: default scan → re-probe the config →
  regenerate with the real sources. But with no local `content/`, Pass 1's default scan finds
  zero collections and writes nothing, so the re-probe's config load STILL fails on the missing
  `DOCS` export → the sources are dropped → `kura index: app/_content.ts not found` and the build
  fails. (It only appeared to work locally when a stale `app/_content.ts` lingered from a prior
  build; a clean CI/Vercel build has none.)

  The bootstrap now seeds `app/_content.ts` with empty stubs for the EXACT names the config
  imports from it (scanned from the config text), so the re-probe loads even before any content
  exists. Apps with local `content/` are unaffected (Pass 1 already seeds them); the seed is
  overwritten by the real freeze that follows a successful probe.

## 0.0.57

### Patch Changes

- [#30](https://github.com/junebuild/june/pull/30) [`25afd3b`](https://github.com/junebuild/june/commit/25afd3b5cdaca9b5026a2356a66f4c7d19bfe9ab) Thanks [@linyiru](https://github.com/linyiru)! - Static prerender: a locale home's .md/.json projections are requested as "/<locale>/index.md" and emitted at "<locale>/index.md", mirroring the root home. "/<locale>.md" has no "/" boundary, so the locale matcher could not strip the prefix and the request fell into the docs catch-all as a phantom slug (a hard 404 on Kura sites, a silently wrong file otherwise). Unblocks i18n static sites.

## 0.0.56

### Patch Changes

- [#29](https://github.com/junebuild/june/pull/29) [`a0023b8`](https://github.com/junebuild/june/commit/a0023b8192c6d0392f229cb434cff5394b2f7378) Thanks [@linyiru](https://github.com/linyiru)! - Fix fresh-build slug flattening: key the content-entry memo by (file, slug, locale), not file alone. The bootstrap two-pass in generateContent scans the same files twice in one process (pass 1 with regex-guessed locales, pass 2 with the declared set); the file-keyed memo handed pass 1's entry (where a 2-3 letter folder like docs/adr/ was mistaken for a locale bucket, producing flat slugs) back to pass 2, freezing wrong slugs into app/\_content.ts on every fresh CI build while warm local builds looked correct.

## 0.0.55

### Patch Changes

- [`336f017`](https://github.com/junebuild/june/commit/336f017cabca77a451f9a36a10aa36686eb81bfc) Thanks [@linyiru](https://github.com/linyiru)! - Content: a doc's title falls back to its first H1 when the frontmatter has no `title:`.

  So plain Markdown with no front-matter still gets a real title (from its `# Heading`) instead
  of defaulting to the slug — "point June at a docs/ folder, change nothing" now holds. A
  frontmatter `title:` still wins; a doc with neither has an undefined title as before.

## 0.0.54

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

- Updated dependencies [[`a6bc035`](https://github.com/junebuild/june/commit/a6bc0351a7e4c76a4c281b75450ef6250c3734bd)]:
  - @junejs/core@0.0.49

## 0.0.53

### Patch Changes

- [#22](https://github.com/junebuild/june/pull/22) [`29fa978`](https://github.com/junebuild/june/commit/29fa978778afb3e8c617b8c87f8ba291b36d9524) Thanks [@linyiru](https://github.com/linyiru)! - Locale buckets are now DECLARED, not guessed — `content/docs/cli/` is content, not a locale

  The content freeze detected locale mirrors by folder shape (a BCP-47-ish regex), so ANY
  2–3-letter top-level folder — `cli/`, `sdk/`, `api/`, `faq/`, `dev/` … — was silently treated
  as a locale bucket and dropped from the default set (its pages never reached `app/_content.ts`).

  `june gen` now takes the locale set from config `i18n` (defaultLocale + `locales` keys):

  - Only declared dirs split off as locale mirrors; everything else is content.
  - **No `i18n` config ⇒ no locale buckets at all** — an undeclared locale is not a locale. If you
    relied on shape-detected mirrors without declaring `i18n`, declare it.
  - The shape regex remains only as the fallback when june.config.ts itself cannot be loaded
    (the wrapper-CLI bootstrap pass), and the bootstrap re-probe carries the declared set.

  `scanCollection`/`collection`/`entry`'s optional `knownLocales` parameter semantics are
  unchanged; the fix is that the freeze now actually passes it.

## 0.0.52

### Patch Changes

- [#20](https://github.com/junebuild/june/pull/20) [`4f6d26a`](https://github.com/junebuild/june/commit/4f6d26ac011d3121f6c6533712b31462c623c19a) Thanks [@linyiru](https://github.com/linyiru)! - Silence two spurious build warnings

  - `CONFIGURATION_FIELD_CONFLICT` no longer fires when the app's tsconfig declares
    `jsxImportSource: "@junejs/core"`: the v0.0.41 skip only covered the worker bundle — the
    CLIENT bundle still set `transform.jsx.importSource` unconditionally. Both passes now share
    one `jsxTransform` helper. The tsconfig reader is also JSONC-tolerant now (comments and
    trailing commas are idiomatic tsconfig; a strict-parse failure silently regressed to
    "not declared" and brought the warning back).
  - `UNRESOLVED_IMPORT react-server-dom-webpack/client.browser` no longer prints on every client
    bundle. That dynamic import (client-router-flight's decoder) is intentionally optional: morph
    apps don't install it, the runtime `import()` rejects, and the navigation hard-falls-back by
    design. The client bundle's `onLog` now silences exactly that log — real unresolved imports
    still warn.

## 0.0.51

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

- Updated dependencies [[`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c)]:
  - @junejs/core@0.0.48

## 0.0.50

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

- Updated dependencies [[`8f77b20`](https://github.com/junebuild/june/commit/8f77b201fe15d94f6404372ab0852972272b88e8)]:
  - @junejs/core@0.0.47

## 0.0.49

### Patch Changes

- [#12](https://github.com/junebuild/june/pull/12) [`bc16ba0`](https://github.com/junebuild/june/commit/bc16ba058a05de952691ebca6a78ce36b3e8dd4d) Thanks [@linyiru](https://github.com/linyiru)! - fix(build): lazy-load oxc-parser in the island registry so it stays out of the runtime bundle

  `island-registry.ts` imported `parseSync` from `oxc-parser` at module top level. oxc-parser eagerly loads a native/wasm binding on import, and `rsc-manifest.ts` (reachable from the runtime worker) pulls this module in for its lightweight helpers (`walk`, `exportNames`, `firstStatementIsDirective`) — none of which need oxc. That dragged oxc-parser's binding into the worker bundle, crashing targets that don't ship it: a Vercel Node function failed with `Cannot find package '@oxc-parser/binding-wasm32-wasi'` (`FUNCTION_INVOCATION_FAILED`). The Workers bundle tree-shakes the chain differently and was unaffected.

  `oxc-parser` is now dynamic-imported inside `generateIslandRegistry` (its only consumer, which runs at build time only). The function becomes async; its two build-time call sites (`build.ts`, `app.ts`) await it.

## 0.0.48

### Patch Changes

- [#10](https://github.com/junebuild/june/pull/10) [`b83df35`](https://github.com/junebuild/june/commit/b83df356771e44818004562640f7e7ff4e476c6d) Thanks [@linyiru](https://github.com/linyiru)! - Render content markdown with @momiji-rs/sparkdown/gfm (wasm) instead of marked

  The content pipeline now renders `entry.html` via `@momiji-rs/sparkdown/gfm` — a WASI-free WebAssembly
  CommonMark + GFM renderer — replacing `marked`. Benchmarked on real docs (Bun): ~75× faster on small
  pages and ~580× faster on large pages (marked degrades super-linearly: a 27KB page took ~130ms; the
  same page renders in ~0.22ms), with GFM (tables, strikethrough, task lists, autolinks) at no extra
  cost. Output is CommonMark-strict: headings stay bare (`<h2>…`), code fences keep `language-*`, and a
  bare `{…}` is literal text. The wasm initializes once per process; this module is build/dev-only, so it
  never enters the worker bundle.
