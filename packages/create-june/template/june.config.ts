import { defineJune } from "@junejs/core/config";
import { sqlite } from "@junejs/server/db";

export default defineJune({
  site: {
    name: "__APP_NAME__",
    titleTemplate: "%s · __APP_NAME__",
    description: "A June app — agent-ready by default.",
  },
  // The agent surface (llms.txt, /mcp, .md/.json projections) is on by default.
  agent: { enabled: true },
  // A built-in database: a local SQLite file in dev (./.june/dev.sqlite), D1 on
  // Cloudflare. Schema is explicit (db/migrations/, applied on `june dev`); use
  // it anywhere with `import { db } from "@junejs/db"`.
  resources: { db: sqlite() },
});
