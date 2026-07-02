---
"@junejs/server": patch
---

Silence two spurious build warnings

- `CONFIGURATION_FIELD_CONFLICT` no longer fires when the app's tsconfig declares
  `jsxImportSource: "@junejs/core"`: the v0.0.41 skip only covered the worker bundle — the
  CLIENT bundle still set `transform.jsx.importSource` unconditionally. Both passes now share
  one `jsxTransform` helper. The tsconfig reader is also JSONC-tolerant now (comments and
  trailing commas are idiomatic tsconfig; a strict-parse failure silently regressed to
  "not declared" and brought the warning back).
- `UNRESOLVED_IMPORT react-server-dom-webpack/client.browser` no longer prints on every client
  bundle. That dynamic import (client-router-flight's decoder) is intentionally optional: morph
  apps don't install it, the runtime `import()` rejects, and the navigation hard-falls-back by
  design. The client bundle's `onLog` now silences exactly that log — real unresolved imports
  still warn.
