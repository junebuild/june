---
"@junejs/core": minor
---

A tool that throws tells the model instead of failing the turn (#232).

Before, when a tool's `run` threw or its promise rejected, the error ended the
whole turn with `turn.failed`: the model never saw it, and the turn's work was
lost. Every app had to wrap each tool body in `try` / `catch` to avoid that.

**Now the error becomes the call's result.** The engine records
`{ error: message }`, checkpointed and appended like any other result, and the
model reads it on its next step and can react.

- **What the model reads:** the message, prefixed with the error's class when
  it isn't a plain `Error`, and cut to 2,000 characters. The stack is never
  included.
- **Tool messages:** a tool `Msg` carries `isError: true`, and the Anthropic
  adapter sends it as a `tool_result` with `is_error: true`.
- **Events and Slack:** `action.completed` carries `error`, including when
  events are replayed from the durable log. The Slack task timeline marks the
  call `error`.
- **Replay and rollback:** a failed call is checkpointed, so a replay doesn't
  re-run it. A sync (local) tool's transaction rolls back first, so the side
  effects it wrote through the store are undone.

**Throw `FatalToolError`** (exported from `@junejs/core/agent-runtime`) for an
error that must end the turn, such as a misconfigured deployment or a broken
invariant. Two existing programming errors now throw it, so they keep failing
the turn:
- a sync tool calling `requestInput`;
- `requestInput` with no `answerers` on a turn whose speaker isn't attested.

**Only what the tool throws is caught.** A failure while recording a successful
result, the store's own error, still fails the turn. The runtime's control
flow also propagates unchanged: `SuspendSignal` still parks the turn
(`input.requested`, `suspended`), and `CancelSignal` still cancels it
(`turn.cancelled`, `cancelled`). Neither is reported to the model.

This matters most for connection tools. OpenAPI non-2xx responses and MCP
`isError` results throw, and now the model sees them as failed calls instead
of the turn dying.
