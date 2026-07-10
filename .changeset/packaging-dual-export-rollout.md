---
"@junejs/db": patch
"@junejs/juno": patch
"@junejs/i18n": patch
"@junejs/og": patch
"@junejs/cli": patch
---

Ship compiled JS + `.d.ts` from the remaining packages so plain Node can consume
them too.

Completes the dual-export rollout started with `@junejs/core`. `@junejs/db`,
`@junejs/juno`, `@junejs/i18n`, `@junejs/og`, and `@junejs/cli` now build to
`dist/` (ESM JS + `.d.ts`) via tsdown and use **dual-condition exports**:
`source`/`bun` still serve `src/*.ts` (the zero-build inner loop, Bun, opt-in
bundlers), while `default`/`types` serve built JS + declarations for Node and
external `tsc`. Notes per package:

- `@junejs/og` keeps its per-runtime backend selection — `workerd`/`edge-light`/
  `default` each map to the right built entry; the OG renderers (`workers-og`,
  `@vercel/og`) stay external so their WASM is never bundled.
- `@junejs/cli` builds only its `.` export (`run(argv)`); the `june` bin still
  runs `src/june.ts` raw under Bun.

`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` is now closed across the whole
workspace.
