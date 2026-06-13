# create-june

Scaffold a [June](https://june.build) app. **Preview (0.0.x): APIs will
change.**

```bash
npm create june my-app
cd my-app && npm run dev
```

The starter ships file routes, a layout, a client island (counter), content
collections, and the agent surface (llms.txt + `/mcp`) — on by default, one
switch off. The scaffolder runs on Node; the `june` CLI it wires up runs on
[Bun](https://bun.sh) (≥ 1.3).

June is the agent-ready React framework: one page serves humans
(streamed HTML) and agents (markdown, JSON, MCP) from the same definition.
Docs: [june.build/docs](https://june.build/docs).
