import { defineJune } from "@junejs/core/config";

// No db resource → june deploy skips the migration step entirely.
export default defineJune({});
