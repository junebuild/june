---
"@junejs/core": patch
---

`ToolContext.initiator` — who OPENED the session, distinct from who is speaking now (#128).

The first resolved principal any turn arrives with is recorded durably under a reserved
step key (no SessionStore contract change; survives eviction with the rest of the log)
and is immutable thereafter. Tools now see both identities: `ctx.principal` stays the
CURRENT turn's resolved identity, `ctx.initiator` is the session's opener — so a
multi-participant thread can express policies like "only the initiator may widen the
query's scope". Deliberately not part of the `requiresPrincipal` gate: tool visibility
keys off the current speaker, so an anonymous follow-up in an operator-opened session
does not inherit the operator's tools. An anonymous opener doesn't claim the seat — the
first RESOLVED principal does.
