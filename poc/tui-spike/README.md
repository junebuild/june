# tui-spike

The throwaway OpenTUI prototype that gates P1c (`docs/rfc-tui.md` §5). Not a June package; delete
it, with `.github/workflows/tui-spike.yml`, once `@junejs/inbox` starts.

- `src/` — a pending list fed by a local SSE feed at 20 events/s (`feed.ts`) and a 2 000-line
  trace pane, on `@opentui/react`. `j`/`k` select, PgUp/PgDn and `g`/`G` scroll the trace, `e`
  opens `$EDITOR` through `renderer.suspend()` / `resume()`, `q` quits, `!` crashes on purpose.
  Off a TTY (stdin or stdout) it prints five lines and exits.
- `harness/run.ts` — runs it under a real pseudo-terminal (`Bun.spawn({ terminal })`: openpty on
  POSIX, ConPTY on Windows), replays the output into headless xterm.js to assert on what a user
  sees, and answers the terminal's startup queries like a real emulator. Exit code = failed checks.
- `harness/installed.ts npm|bun` — packs the spike, installs the tarball into a fresh project and
  runs the harness against the bin the package manager made.

```sh
bun install
bun harness/run.ts                          # from source
bun build --compile src/main.tsx --outfile dist/tui-spike
bun harness/run.ts --bin dist/tui-spike     # the compiled binary
bun harness/installed.ts npm                # npm install of the packed tarball
bun harness/installed.ts bun
```

## What the harness checks

| scenario | checks |
|---|---|
| session | renders; feed live; CJK on screen; box borders in the same columns on every row; no stale cells after emoji (Unicode 11 widths); no full-screen clears and ≥ 10 events/s while keys are pressed (a starved event loop drops to single digits); `$EDITOR` runs with the terminal and the TUI comes back; resize 120x40 and 60x20; `q` exits 0; terminal restored; mounted once, one feed subscription, suspend/resume paired |
| ctrl-c, crash, sigterm | exits 130 / 1 / 143 and restores alternate screen, cursor and mouse modes (sigterm skipped on Windows) |
| stdin redirected | stdout a TTY, stdin `/dev/null` or `NUL`: no full-screen UI, prints the listing, exits 0 |
| no TTY | pipes only: plain text, five lines, exits 0 |

Reported but not asserted: frame times, bytes/s, `widthMethod`, and stale cells when the same bytes
are replayed with Unicode 6 widths (a stand-in for legacy `wcwidth` tables).

## Results (verified 2026-09-28, Bun 1.3.14, OpenTUI 0.5.12)

| target | source | compiled | npm | bun |
|---|---|---|---|---|
| darwin-arm64 (MacBook Air M3) | ✅ 44/44 | ✅ 44/44¹ | ✅ 44/44 | ✅ 44/44 |
| win32-x64 (starship-win11, over SSH) | ✅ 39/39² | ✅ 39/39² | ✅ 39/39² | ✅ 39/39² |
| the other six targets | CI: `.github/workflows/tui-spike.yml` | | | |

Frame times on darwin-arm64: 2.8–3.6 ms average, 10–23 ms worst, at ~160 KB/s of terminal output
while streaming. On win32-x64: 3.9 ms average, 10 ms worst, ~25 KB/s.

¹ Two of three runs; the first run right after compiling hit one 62 ms frame and measured
11.5 events/s, which is why the threshold is 10/s, not 12/s.
² Four checks fewer: SIGTERM is skipped on Windows. Run with the 12/s threshold (16.5/s measured).

## Findings so far

1. **Emoji width depends on the terminal's width table.** OpenTUI picks a width method at startup
   (`unicode-wide` on macOS, `unicode` under Windows ConPTY). Replayed with Unicode 11 widths
   (VS Code, Windows Terminal, current emulators) the screen is clean; with Unicode 6 widths a
   stale cell follows `☕` (`☕r`). CJK text itself is unaffected, and borders stay aligned.
2. **Install size is ~67 MB, not ~20 MB.** A fresh `npm install @opentui/core @opentui/react react`
   also installs auto-installed peers: `typescript` (23 MB, a peer of `bun-ffi-structs`),
   `react-devtools-core` (15 MB, a peer of `@opentui/react`) and `web-tree-sitter` (5.7 MB). The
   compiled binary does not pay this; `bunx @junejs/inbox` does.
3. **Windows timers tick every 15.6 ms**, so a 50 ms interval fires every ~63 ms: the fake feed
   runs at ~16/s there. The TUI keeps up (16.5/s while keys are pressed).
4. **Layout**: Yoga defaults `flexShrink` to 0, so a flex child with long content pushes its
   siblings off screen unless it sets `flexShrink: 1, minHeight: 0`.
5. **Spawning on Windows**: npm makes `.cmd` shims, bun makes `.exe` shims; `cmd.exe` does not
   parse backslash-escaped quotes; Windows PowerShell 5.1 strips quotes from arguments to native
   commands (hence `--bin`).

## Still manual

- `$EDITOR` with a real editor: vim, and VS Code with `EDITOR="code --wait"`.
- Flicker by eye in a real terminal at 20 events/s while scrolling the trace (Ghostty, iTerm2,
  Terminal.app, Windows Terminal, VS Code).
