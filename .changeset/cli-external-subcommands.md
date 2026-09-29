---
"@junejs/cli": minor
---

External subcommands: `june <verb>` that is not built in runs `june-<verb>` (#295).

The git / cargo model, for clients that ship on their own — first, the operator inbox
(`@junejs/inbox` behind `june inbox`, email RFC §9.3):

- Looked up in `node_modules/.bin` from the working directory up (hoisted bins included), then
  on `PATH`. Built-in verbs always win; a verb must be a plain lowercase name, so `june ../x`
  never resolves.
- The arguments are passed exactly as typed (June's parser never sees them), the terminal is
  inherited, the exit code is returned (128 + the signal when it is killed), and SIGTERM /
  SIGHUP are forwarded.
- On Windows, a `.cmd` / `.bat` target runs through `cmd.exe` with cross-spawn's escaping: every
  argument quoted and its metacharacters `^`-escaped (twice for an npm shim). Verified on
  Windows 11 with 23 hostile arguments through both an npm `.cmd` shim and a bun `.exe` shim:
  all arrived literally, nothing was injected — where a plain `cmd.exe /c` split `a&b` and ran
  `b` as a command.
- **The `june` launcher (`bin.mjs`) relays signals.** It waited on Bun with `spawnSync`, so a
  SIGTERM / SIGHUP sent to the `june` pid killed the Node wrapper and orphaned Bun — and
  whatever Bun ran: `june dev`, or an external command. It now runs Bun asynchronously,
  relays SIGTERM / SIGHUP, and mirrors the exit (128 + the signal). SIGINT is caught and
  relayed only without a terminal: Ctrl-C in a terminal already reaches the whole foreground
  group, and a second SIGINT would force what should be a graceful stop — verified through a
  PTY (exactly one SIGINT arrives; relaying always sent two).
- A table of first-party external verbs feeds `june help` and an install hint when one is
  missing; it stays empty until `@junejs/inbox` publishes.
- An unknown verb says where it looked.
