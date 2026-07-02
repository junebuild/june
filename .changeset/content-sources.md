---
"@junejs/core": patch
"@junejs/server": patch
"@junejs/cli": patch
---

Configurable content sources: `content.sources` in june.config.ts

Content no longer has to live under `content/<collection>/`. Config can declare extra source
directories — including ones outside the app root — that merge into named collections:

```ts
export default defineJune({
  content: {
    sources: [
      { dir: "../docs", collection: "docs" }, // the repo's own docs/, docs-as-code
      { dir: "../schema", collection: "docs", mount: "schema" }, // slugs prefixed schema/…
    ],
  },
});
```

- Each source scans with the same locale-mirror layout as `content/` (`<dir>/<locale>/…`).
- `mount` prefixes slugs; a source's root `index.md`/`README.md` becomes the mount's page.
- A slug collision between sources fails `june gen` loudly, naming both files. A missing
  configured dir is a build error, not a silent skip.
- Bootstrap-safe: a wrapper-generated config that imports `app/_content.ts` (which only exists
  AFTER the first freeze) self-heals — `june gen` generates the default scan, re-probes the
  config in a fresh subprocess, and regenerates with the sources applied.
- `june dev` watches configured source dirs (they're outside the app root, invisible to the
  root watcher) and regenerates + restarts on change.
