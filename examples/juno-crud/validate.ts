// End-to-end: drive a real June app (ambient db + Juno table) through createApp().
// Run: cd examples/juno-crud && bun validate.ts
import { createApp, sqlite } from "@junejs/server";
import { junoDataLayer } from "@junejs/juno";

const app = createApp({
  appDir: new URL("./app", import.meta.url).pathname,
  config: { resources: { db: sqlite({ path: ":memory:" }) }, dataLayer: junoDataLayer() },
});

const res = await app.fetch(new Request("http://x/"));
const html = await res.text();
const ok = res.status === 200 && html.includes("Ada") && html.includes("Linus") && html.includes("Grace");
console.log("status:", res.status);
console.log("renders the 3 seeded users:", ok);
if (!ok) {
  console.log("--- html (first 600) ---\n" + html.slice(0, 600));
  process.exit(1);
}
console.log("OK — ambient db (seed) + Juno table().all() (read) work through the real pipeline.");
process.exit(0);
