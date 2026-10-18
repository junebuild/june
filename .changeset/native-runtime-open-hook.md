---
"@junejs/server": patch
---

`createNativeRuntime` can open the sessions file through your own function, for a store keyed per tenant (SQLCipher or similar) or a driver other than the built-in one (#399). Pass `open(path)` and return a ready handle. If the store needs a key, set it before you return the handle:

```ts
import Database from "better-sqlite3-multiple-ciphers";
import { createNativeRuntime, fromPrepare } from "@junejs/server/agent-native";

const runtime = await createNativeRuntime(agents, `./tenants/${tenant}.db`, {
  open: (path) => {
    const db = new Database(path);
    db.pragma(`key = '${keyFor(tenant)}'`);
    return fromPrepare(db);
  },
});
```

The runtime owns that handle the way it owns the one it opens itself. It switches the handle to the durable journal (WAL, `synchronous=FULL`) and delivers input announcements left over from the last run. `close()` closes the handle, and so does a start that fails. Before this, opening the store yourself meant using `new NativeRuntime(agents, db)` and doing all three by hand. `createAgentRuntime` passes `open` through to the native backend.

`@junejs/server/agent-native` now exports `SyncSqlite`, `SyncStatement` and `PreparedSqlite`. It also exports `fromPrepare()`, which adapts a `prepare()`-shaped driver (`node:sqlite`, `better-sqlite3`) to `SyncSqlite`.
