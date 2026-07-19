---
"@junejs/core": patch
"@junejs/server": patch
---

Turn failures carry the full error, serialized at the throw site (#96):

- `turn.failed` (and `TurnResult`'s failed arm) now carry `TurnError` — `{ message, stack?, causeChain? }` — plus `phase` ("model" | "tool") and `step` (the in-flight step id, e.g. `model:3` / `tool:call_7`) naming what was running when the turn died. Non-Error throwables keep their JSON shape instead of collapsing to "[object Object]".
- `onTurnError` receives the extended payload unchanged from the failure site — for a detached turn this hook is the only failure-surfacing path, so nothing is flattened before it fires. Backwards-compatible: all new fields are additions.
- The DO's default failure log (wrangler tail) prints the step and the real stack trace (plus a `caused by:` chain) instead of the message alone.
- The SSE-collapsing paths (`sseTurnFinalText`, the channel non-streamed reply) rethrow with the full `TurnError` as `cause`.
- New export: `serializeTurnError(err)` (cycle-capped `cause` walk).
