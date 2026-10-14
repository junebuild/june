import { defineJune } from "@junejs/core/config";

// A worker that imports a font file (#379): the build leaves it external, and workers()
// must give wrangler a loader for it. The font is @junejs/server's own favicon subset.
export default defineJune({ site: { name: "Font App" } });
