---
"@junejs/core": minor
"@junejs/server": minor
---

Add agent channels — inbound edges (http / slack / crisp).

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
