---
"@junejs/server": patch
---

DO seam: constrain the structural `SqlStorage`/`SqlStorageCursor` row generic so
`this.ctx` from `@cloudflare/workers-types` assigns directly — no cast in a DO shell.

`agent-durable.ts` describes the Cloudflare surface with minimal structural interfaces
(no `@cloudflare/workers-types` dep). Its `exec<T = Record<string, unknown>>` left `T`
unconstrained, while workers-types uses `exec<T extends Record<string, SqlStorageValue>>`.
An unconstrained `T` promises `toArray(): T[]` for arbitrary `T`, which workerd's
cursor — only ever `Record<string, SqlStorageValue>` rows — cannot satisfy, so passing
`this.ctx.storage` into `AgentDurableObject`/`DoSessionStore` failed to typecheck and each
consumer paid the same `as unknown as JuneDoState` tax.

Fix: mirror the constraint STRUCTURALLY (still no workers-types import). Add
`export type SqlStorageValue = ArrayBuffer | string | number | null` and constrain both
`exec` and `SqlStorageCursor` to `T extends Record<string, SqlStorageValue>`. The two
`exec` signatures now unify, so `this.ctx` is assignable with no cast. Backward compatible:
existing typed calls (`exec<{ body: string }>`) and bare side-effect calls still compile,
and the constraint correctly rejects impossible row types (e.g. a `Date` column). Changing
only the default — not the constraint — does NOT fix this; the constraint is load-bearing.
