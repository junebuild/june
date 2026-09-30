---
"@junejs/server": patch
---

Local SQLite files — the native agent store and the `sqlite()` app database — now open in WAL mode with `synchronous=FULL`. With SQLite's default rollback journal, a power cut right after a commit could roll that committed transaction back on the next open: an agent turn parked on a human (`ctx.requestInput`) was gone after the host came back, even though the caller had already been told it was suspended. WAL at `FULL` fsyncs every commit. `journal_mode=WAL` persists in the file, so existing databases switch on their next open and gain `-wal` / `-shm` companion files beside them; keep the database on a local disk (WAL does not work over network filesystems). `:memory:` databases are unchanged.
