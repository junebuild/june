---
"@junejs/core": patch
"@junejs/server": patch
---

Channel turn control (#129): cancel-and-replace and session reset.

Cancel-and-replace — a correction sent while a turn is still running supersedes it instead of queuing behind it: the engine polls a per-turn cancel flag at checkpoint boundaries only (between model deltas, between tool calls), so a cancelled turn always leaves a transcript the next turn can build on — a partially-run tool batch is closed with synthetic results, nothing dangles. `start({ replace: true })` / `/turn?replace=1` / a `replace` flag on ChannelContext run variants supersede every unfinished turn (a suspended approval is never cancelled); the turn settles as `{ status: "cancelled" }` and emits `turn.cancelled`. slackChannel adopts it via the opt-in `replaceInFlight` option (message/app_mention only) and renders a superseded stream with a "(superseded)" note.

Session reset — `ctx.resetSession()` / `POST /reset` / `AgentSession.reset()` terminally retires a session's accumulated history: unfinished turns are superseded, then messages/steps/status are ARCHIVED under a generation counter (the audit trail — never deleted) and live state starts fresh (empty transcript, open initiator seat, any stale suspended park cleared). The session's address never changes; the returned `previousSession` handle (`<session>#g<N>`) names the archived generation. All three SessionStores (Durable Object, native SQLite, memory) implement the archival.
