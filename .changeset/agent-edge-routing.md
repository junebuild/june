---
"@junejs/server": patch
---

Route the durable agent chat endpoint to a per-session Durable Object on the edge.

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
