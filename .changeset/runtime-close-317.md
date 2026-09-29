---
"@junejs/server": minor
---

`NativeRuntime` and `MemoryRuntime` gain `close()` (#317). It cancels pending input-announcement retries, drops the actors, and, on a runtime built by `createNativeRuntime`, closes the SQLite database it opened. A database passed to `new NativeRuntime` stays the caller's. The retry timer is `unref`'d, so it never held a process open, but it still fired while the process lived. A runtime discarded in a long-running process, such as a test suite, would retry seconds later against a closed or deleted database. Safe to call twice.
