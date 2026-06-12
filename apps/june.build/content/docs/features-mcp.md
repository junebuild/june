---
title: "Built-in MCP"
nav: "MCP"
description: Every June app is an MCP server — defineAction() is simultaneously a server action, an MCP tool, and a manifest entry, behind one authorization gate.
date: 2026-06-12
section: Features
order: "1"
---
## The feature

Turn on `agent.mcp` (it's on by default) and your app serves MCP at `/mcp` —
no separate server, no adapter, no tool re-declaration:

```ts
export const createUser = defineAction({
  id: "createUser",
  description: "Create a user",          // description → listed as an MCP tool
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  run: (input, ctx) => {
    // ctx carries the principal + resources — the SAME ctx whether the caller
    // is your React UI or an agent calling /mcp. Authorize here, once.
    return ctx.db.insert("users", input);
  },
});
```

One `defineAction()` is simultaneously a **server action** (pass it to client
components as a prop), an **MCP tool** (auto-listed with its schema), and a
**manifest entry** agents discover. There is no "expose to agents" step and
no second permission system: `run(input, ctx)` is the only gate, so an agent
can never do anything your UI's authorization wouldn't allow.

## Try it on this site

This site's search is an action. Call it the way an agent would:

```bash
curl -X POST https://june.build/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

curl -X POST https://june.build/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_site","arguments":{"query":"cold start"}}}'
```

## Why it matters

Tools are intent-shaped and policy-checked — never auto-generated CRUD. The
agent surface is exactly as capable as you declared, and exactly as
authorized as your UI.
