import { defineJune } from "@junejs/core/config";
import { sqlite } from "@junejs/server";
import { junoDataLayer } from "@junejs/juno";

// Declaring `dataLayer: junoDataLayer()` opts this app into Juno (Tier 3): the
// canonical ambient `db` auto-tags raw queries, and `table()` is available.
export default defineJune({
  site: { name: "Juno CRUD" },
  resources: { db: sqlite() },
  dataLayer: junoDataLayer(),
});
