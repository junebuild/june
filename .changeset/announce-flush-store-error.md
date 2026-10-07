---
"@junejs/core": patch
---

`AgentSession.flushAnnouncements()` now keeps its "never rejects" promise when the store itself fails (#260). Its first step reads the announcement outbox, and that read ran outside the error handling, so a store that threw made the call throw synchronously. Callers fire it and forget it, including `NativeRuntime`'s retry timer. There, a closed or failing SQLite database became an uncaught exception, which takes a Node process down by default. The failed read is now logged like a failed delivery, and the announcement stays recorded for the next flush.
