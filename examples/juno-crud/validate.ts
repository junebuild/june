// End-to-end: drive a real June app (ambient db + Juno table) through createApp().
// Run: cd examples/juno-crud && bun validate.ts
//
// Schema is owned by db/migrations/ (not the loader), so we migrate first — the same
// thing `june dev` does — then serve. A temp FILE db (not :memory:) so the migration
// and createApp share one database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, sqlite, migrateApp } from "@junejs/server";
import { junoDataLayer } from "@junejs/juno";

const root = new URL(".", import.meta.url).pathname; // the example dir (holds db/migrations)
const dbDir = mkdtempSync(join(tmpdir(), "juno-crud-"));
const config = { resources: { db: sqlite({ path: join(dbDir, "dev.sqlite") }) }, dataLayer: junoDataLayer() };

let html = "";
let status = 0;
try {
  await migrateApp(root, config); // apply db/migrations/ → the users table exists

  const app = createApp({ appDir: join(root, "app"), config });
  const res = await app.fetch(new Request("http://x/"));
  status = res.status;
  html = await res.text();
} finally {
  rmSync(dbDir, { recursive: true, force: true });
}

const ok = status === 200 && html.includes("Ada") && html.includes("Linus") && html.includes("Grace");
console.log("status:", status);
console.log("renders the 3 seeded users:", ok);
if (!ok) {
  console.log("--- html (first 600) ---\n" + html.slice(0, 600));
  process.exit(1);
}
console.log("OK — migration (schema) + ambient db (seed) + typed table().all() (read) work end to end.");
process.exit(0);
