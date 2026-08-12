---
"@junejs/cli": patch
---

Remove three `june dev` first-run friction points:

- **`PORT` is honored.** Port precedence is now `--port` > `PORT` env > `3000`, so the
  platform convention devs expect (`PORT=4100 june dev`) is no longer silently ignored. A
  shared `coercePort` also fixes a pre-existing footgun where `--port` with no value bound
  port 1 (`Number(true) === 1`); junk values (`PORT=abc`, `PORT=`, out of range) fall back
  cleanly.
- **`*.log` files no longer restart the dev watcher.** A log written into the project tree
  (e.g. `dev.log` in CI) previously matched no ignore rule and looped `[june] … changed —
  restarting` forever. A `.log` is app output, never a source edit.
- **`--help` after a verb prints help instead of running the command.** `june dev --help`
  started the dev server (and hung); `june build --help` built. `--help` in any position now
  prints usage with no side effect.
