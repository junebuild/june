---
"@junejs/core": minor
---

A local tool that returns a Promise fails the turn instead of committing `{}` as its result (#233). A new `mode: "local" | "remote"` option declares how a tool runs.

- The engine still classifies a tool by its `run`: an `async` function runs remote (at-least-once, may `ctx.requestInput`), anything else local (exactly-once inside the store transaction). A `run` that returns a Promise without the `async` keyword was classified local, and the Promise was checkpointed and appended as the result, so the model read `{}` and the real result or rejection was lost. Now the turn fails with a `FatalToolError` that names the tool and the fix. The transaction rolls back and nothing is recorded. The Promise's rejection is swallowed, so it can't surface as an unhandled rejection.
- `Tool.mode` and `defineAction({ mode })` override the classification. Use `mode: "remote"` for a wrapper (`withRetry(async …)`), a plain function returning a client's Promise, or code compiled below ES2017. `toolMode(run, mode)` is exported from `@junejs/core/agent-runtime` and returns the mode the engine will use.
