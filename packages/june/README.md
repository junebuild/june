# @junejs/server

June's host layer: the dev server, the render pipeline, the build (Workers
bundle), and the host adapters (Bun / Node — detected at runtime). Depends
inward on the pure `@junejs/core` contract layer; apps usually consume this
through `@junejs/cli` rather than directly. **Preview (0.0.x): APIs will
change.**

```ts
import { createApp, loadJuneConfig } from "@junejs/server";

const app = createApp({ appDir, config: await loadJuneConfig(root) });
// a June app is one Web-standard fetch handler
export default { fetch: (req: Request) => app.fetch(req) };
```

Site & docs: [june.build](https://june.build).
