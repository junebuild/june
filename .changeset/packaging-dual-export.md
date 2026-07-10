---
"@junejs/core": patch
"@junejs/server": patch
---

Ship compiled JS + `.d.ts` so plain Node can consume `@junejs/core`.

Node refuses to type-strip `node_modules` `.ts`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so importing `@junejs/core`'s raw
`.ts` from plain Node failed. `@junejs/core` now builds to `dist/` (ESM JS +
`.d.ts`) via tsdown and uses **dual-condition exports**: `source`/`bun` still
serve `src/*.ts` (the zero-build inner loop, Bun, opt-in bundlers), while
`default`/`types` serve built JS + declarations for Node and external `tsc`.
`june build` resolves `@junejs/*` via a new `source` condition so it keeps
bundling source (no dist dependency). Second dogfood packaging fix after erasable;
`@junejs/core` is the pilot — the remaining packages follow.
