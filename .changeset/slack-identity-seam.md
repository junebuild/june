---
"@junejs/core": patch
---

slackChannel gains `resolveIdentity` — the Slack sibling of crispChannel's identity seam.

Map the platform-verified sender (the user/team ids inside the signature-verified event
payload) to the app's own Principal before any consumer of a normalized event runs. Unlike
Crisp — where webhook user fields are client-writable hints and evidence must be pulled
over REST — Slack's sender facts are already the platform's own assertion, so the resolver
is a pure policy decision (e.g. "workspace members of team T become operator principals";
enforce a team allowlist) with no extra latency. The result is pinned on `event.principal`,
flows to `ToolContext.principal`, and gates `Tool.requiresPrincipal` tools; observers and
the respond path share one resolution (the crisp channel's exact pattern). Fail-closed: a
throwing resolver reports to `onError` and the turn runs anonymous. Adds the exported
`SlackIdentity` type.
