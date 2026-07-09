# @junejs/cli

## 0.0.51-dev.0

### Patch Changes

- Updated dependencies [[`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`e70960d`](https://github.com/junebuild/june/commit/e70960d19ac1f70da54e22f666891ce5b1c4ba77), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090)]:
  - @junejs/core@0.1.0-dev.0
  - @junejs/server@0.1.0-dev.0

## 0.0.50

### Patch Changes

- [#18](https://github.com/junebuild/june/pull/18) [`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c) Thanks [@linyiru](https://github.com/linyiru)! - Configurable content sources: `content.sources` in june.config.ts

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

- Updated dependencies [[`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c)]:
  - @junejs/core@0.0.48
  - @junejs/server@0.0.51
