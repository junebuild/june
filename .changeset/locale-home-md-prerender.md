---
"@junejs/server": patch
---

Static prerender: a locale home's .md/.json projections are requested as "/<locale>/index.md" and emitted at "<locale>/index.md", mirroring the root home. "/<locale>.md" has no "/" boundary, so the locale matcher could not strip the prefix and the request fell into the docs catch-all as a phantom slug (a hard 404 on Kura sites, a silently wrong file otherwise). Unblocks i18n static sites.
