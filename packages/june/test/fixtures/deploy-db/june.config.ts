import { defineJune } from "@junejs/core/config";
import { sqlite } from "@junejs/server/db";

// A db resource is declared → june deploy migrates D1 before shipping. The
// factory's .open() is never called on the deploy path (migrateD1 uses the
// wrangler transport), so this is just the "db exists" marker.
export default defineJune({ resources: { db: sqlite() } });
