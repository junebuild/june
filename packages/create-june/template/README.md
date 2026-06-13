# __APP_NAME__

A [June](https://june.build) app — the agent-native React framework.

## Develop

```sh
npm install
npm run dev      # → http://localhost:3000
```

Every route answers from one definition — humans get HTML, data clients get
`.json`, agents get `.md`, and actions are MCP tools at `/mcp`:

```sh
curl localhost:3000/users          # HTML
curl localhost:3000/users.json     # data
curl localhost:3000/users.md       # markdown
```

```sh
npm run info     # routes + the agent surface (what an agent sees)
npm run build    # a workerd-ready bundle
npm run deploy   # → Cloudflare Workers
```

Point an MCP client (Claude, Cursor) at `http://localhost:3000/mcp` and it can
list and call your `defineAction` tools.
