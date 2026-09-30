---
"@junejs/server": minor
---

`NativeRuntime` and `MemoryRuntime` gain `close(): Promise<void>` (#317), and `createAgentRuntime` now returns an `InProcessRuntime` (a `Runtime` with `close()`).

On `close()`:
- Pending input-announcement retries are cancelled, and no new session opens.
- `NativeRuntime` then waits until every actor is idle, because a running turn or an announcement delivery in flight still writes the store after its hook or model call returns.
- The actors are dropped. On a runtime built by `createNativeRuntime`, the SQLite database it opened is closed. A database passed to `new NativeRuntime` stays the caller's.
- Calling it twice is safe.

Why: the retry timer is `unref`'d, so it never held a process open, but it still fired while the process lived. A runtime discarded in a long-running process, such as a test suite, would retry seconds later against a closed or deleted database.
