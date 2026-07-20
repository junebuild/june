---
"@junejs/core": patch
---

New `@junejs/core/test` entry (#93) — the test scaffolding every June app was re-implementing by hand, shipped inside core so the fakes stay in version-lockstep with the surfaces they mirror (a subpath, not a separate package, so drift is structurally impossible and there is nothing extra to install):

- `signSlackRequest(secret, body, { ts?, url? })` / `signCrispRequest(…)` — build a `Request` that passes the real channels' signature verification (ts override for staleness tests).
- `makeTestContext({ reply?, streamEvents?, detached?, resumeEvents?, services?, agent? })` — a fake `ChannelContext` with call capture (`ctx.calls.run/runStream/runDetached/resumeStream/waitUntil`) and `ctx.flush()`, an exact join on fast-ACK background work (including work enqueued while settling) that replaces sleep-based flushing. Optional surfaces (`runStream`/`runDetached`/`resumeStream`) appear only when their fixture is provided, keeping channel feature-detection honest.
- `turnEvents({ reasoning?, deltas?, text? | fail? | input? })` — build a turn's streaming fixture: `turn.started`, deltas, exactly one terminal.
