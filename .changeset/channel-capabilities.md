---
"@junejs/core": patch
"@junejs/server": patch
---

Channel capabilities: agents can now read and act on chat platforms, not just echo text.

- `InboundEvent` normalized envelope threaded into turn + tool context (`ToolContext.event`), carried end-to-end over the durable `/turn` RPC and the native path.
- Channels can contribute outbound capability tools (`Channel.tools`), merged into `agent.tools` by `defineAgent` (which now throws on a duplicate tool name).
- Slack: `slack_read_thread`, `slack_list_reactions`, `slack_resolve_user`, `slack_add_reaction`; `message` / `app_mention` / `reaction_added` / `reaction_removed` event turns (reactions opt-in via `events`, `botUserId` loop guard).
- Crisp: normalized envelope + `crisp_read_conversation`; empty replies no longer posted.
- Cross-channel safety: tools default their target from the current event only when `event.source` matches. Durable `/turn` serialization drops an unserializable `event.raw` instead of failing the turn.
