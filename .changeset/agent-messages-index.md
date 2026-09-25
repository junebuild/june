---
"@junejs/server": patch
---

The native agent store indexes `agent_messages(session_id, seq)` (#168). Every store read is scoped to one session, but with no index each one scanned the messages of every session in the file, so per-turn cost grew with the whole database. The index is created with `IF NOT EXISTS` at runtime construction, so existing files gain it on the next start. `hasOpeningMessage` (asked once per turn start) now probes for the single row instead of parsing the whole transcript.
