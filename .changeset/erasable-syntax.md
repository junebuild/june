---
"@junejs/core": patch
"@junejs/server": patch
"@junejs/juno": patch
---

Fix: keep shipped source erasable (no TS parameter properties).

June publishes raw `.ts`, so a consumer's `tsc` type-strips our source under
their flags — and constructor parameter properties (`constructor(private x: T)`)
are **not** erasable, breaking `erasableSyntaxOnly` and Node's native
`--experimental-strip-types`. Rewrote every parameter property to an explicit
field + assignment (`AgentSession`, the native/DO session stores + runtimes,
`RedisStore`, juno's `Table`).

Mechanism so it can't recur: **`erasableSyntaxOnly: true` in `tsconfig.base.json`**
— the root `typecheck` (which `bun run ci` runs, gating publish) now fails on any
non-erasable syntax (parameter properties, enums, namespaces, `import =`) across
every package's src and tests.
