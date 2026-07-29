---
"@junejs/core": patch
---

slackChannel gains `resolveIdentity` — the Slack sibling of crispChannel's identity seam.

Map the platform-verified sender (the ids inside the signature-verified event payload) to
the app's own Principal before any consumer of a normalized event runs. Unlike Crisp —
where webhook user fields are client-writable hints and evidence must be pulled over REST —
Slack's sender facts are already the platform's own assertion, so the resolver is a pure
policy decision with no extra latency. The result is pinned on `event.principal`, flows to
`ToolContext.principal`, and gates `Tool.requiresPrincipal` tools; observers and the
respond path share one resolution (the crisp channel's exact pattern). Fail-closed: a
throwing resolver reports to `onError` and the turn runs anonymous.

The exported `SlackIdentity` type separates two facts a grant must not conflate: `teamId`
is the ENVELOPE workspace (where the app received the event — a Slack Connect external
participant in a shared channel arrives under the same envelope), while `senderTeamId`
carries the sender's home workspace when Slack includes it on the event. Elevated
(staff/operator) grants should verify membership explicitly — an explicit user-id
allowlist, a users.info lookup, or both — never the envelope team alone:

```ts
resolveIdentity: ({ userId, senderTeamId }) =>
  userId && STAFF_USER_IDS.has(userId) && senderTeamId === OUR_TEAM
    ? { id: `slack:${userId}`, kind: "operator" }
    : null,
```
