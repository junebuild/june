---
"@junejs/core": patch
"@junejs/server": patch
---

Follow-ups to native session eviction (#174). The server↔core runtime contract moves to v2 (`RUNTIME_API_VERSION` in core, the expected number in server, in lockstep): `NativeRuntime` now calls `AgentSession.idle()`, so a server paired with an older, nested core copy fails at construction with both versions named instead of at the first eviction with "idle is not a function". `maxSessions` is validated — an integer >= 1, or `Infinity` for no cap; `0`, negatives, fractions and `NaN` throw a `RangeError` at construction.
