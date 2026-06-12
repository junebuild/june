# @junejs/cli

The `june` command — dev, build, deploy, gen, info. **Preview (0.0.x): APIs
will change.**

```bash
npm create june my-app    # scaffolds and wires this CLI locally
cd my-app && npm run dev
```

```
june dev      # dev server with watch + browser live-reload (--no-watch, --port)
june build    # Cloudflare Workers bundle: dist/worker.js + prerendered assets
june deploy   # build + wrangler upload (--dry-run validates only)
june gen      # freeze content/**/*.md → app/_content.ts
june info     # routes + the agent surface (MCP tools, discovery endpoints)
```

Runs on [Bun](https://bun.sh) (≥ 1.3) — the scaffolder itself (`npm create
june`) runs on Node. Site & docs: [june.build](https://june.build) · every
docs page is also markdown (append `.md`).
