import { defineJune } from "@junejs/core/config";
import { turso, vercel } from "@junejs/server";

// Vercel (Node runtime) + a turso() db — the libsql-over-HTTPS default. The build
// opens this declared factory from env (→ ambient `import { db }`) and bundles the
// pure-fetch web client into the function.
export default defineJune({
  deploy: { adapter: vercel() },
  resources: { db: turso() },
});
