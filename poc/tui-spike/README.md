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
| session | renders; feed live; CJK on screen; box borders in the same columns on every row; no stale cells after emoji (Unicode 11 widths); no full-screen clears and ≥ 5 events/s while keys are pressed (a starved event loop drops to ~0); `$EDITOR` runs with the terminal and the TUI comes back; resize 120x40 and 60x20; `q` exits 0; terminal restored; mounted once, one feed subscription, suspend/resume paired |
| ctrl-c, crash, sigterm | exits 130 / 1 / 143 and restores alternate screen, cursor and mouse modes (sigterm skipped on Windows) |
| stdin redirected | stdout a TTY, stdin `/dev/null` or `NUL`: no full-screen UI, prints the listing, exits 0 |
| no TTY | pipes only: plain text, five lines, exits 0 |

Reported but not asserted: frame times, bytes/s, `widthMethod`, and stale cells when the same bytes
are replayed with Unicode 6 widths (a stand-in for legacy `wcwidth` tables).

## Results

CI run [36461777855](https://github.com/junebuild/june/actions/runs/36461777855) (2026-09-28,
OpenTUI 0.5.12, Bun 1.4.2 on every target). Windows runs 39 checks: SIGTERM is skipped. Alpine
has no npm, so musl has no npm column.

| target | source | compiled | npm | bun | frame avg / max | events/s |
|---|---|---|---|---|---|---|
| darwin-arm64 | ✅ 44/44 | ✅ 44/44 | ✅ 44/44 | ✅ 44/44 | 2.7 / 14.9 ms | 19.5 |
| darwin-x64 | ✅ 44/44 | ✅ 44/44 | ✅ 44/44 | ✅ 44/44 | 11.2 / 165.5 ms | 17.5 |
| linux-x64 | ✅ 44/44 | ✅ 44/44 | ✅ 44/44 | ✅ 44/44 | 3.8 / 14.9 ms | 17.5 |
| linux-arm64 | ✅ 44/44 | ✅ 44/44 | ✅ 44/44 | ✅ 44/44 | 4.0 / 22.5 ms | 17.5 |
| linux-x64-musl | ✅ 44/44 | ✅ 44/44 | — | ✅ 44/44 | 5.5 / 17.9 ms | 18 |
| linux-arm64-musl | ✅ 44/44 | ✅ 44/44 | — | ✅ 44/44 | 3.9 / 15.3 ms | 17.5 |
| win32-x64 | ✅ 39/39 | ✅ 39/39 | ✅ 39/39 | ✅ 39/39 | 5.4 / 24.7 ms | 18 |
| win32-arm64 | ✅ 39/39 | ✅ 39/39 | ✅ 39/39 | ✅ 39/39 | 4.3 / 17.6 ms | 18 |

On Bun 1.3.14 (run [36460069360](https://github.com/junebuild/june/actions/runs/36460069360))
the same checks passed everywhere except Windows arm64, where the native core does not load
(finding 1), and frames were slower: 5–8 ms average against 2.7–5.5 ms on 1.4.2.

Also verified by hand: darwin-arm64 (MacBook Air M3) and win32-x64 (starship-win11 over SSH), all
four paths, 2026-09-28, on Bun 1.3.14.

## Findings

1. **Windows arm64 needs Bun ≥ 1.4.2.** Bun 1.3.14's native Windows arm64 build ships without
   TinyCC, so `bun:ffi` fails with `dlopen() is not available in this build (TinyCC is
   disabled)` — and OpenTUI loads its core through `bun:ffi`. Bun 1.4.2 passes everything. x64
   Bun 1.3.14 under emulation is not a way out: from source it passes, but the compiled and
   bun-installed bins die a few events after the first frame (EPIPE), and npm installs the arm64
   native package, which x64 Bun cannot load. June now follows the newest Bun (#281), so this is
   closed; the workflow runs every target on 1.4.2.
2. **OpenTUI does not detect musl.** It loads `@opentui/core-linux-<arch>-musl` only when
   `OPENTUI_LIBC=musl`; otherwise it dlopens the glibc build, which on Alpine x64 fails with
   `Error loading shared library ld-linux-x86-64.so.2`. (On Alpine arm64 the glibc build happened
   to load; not something to rely on.) `src/libc.ts` sets the variable when `/lib` has a musl
   loader, before `@opentui/core` evaluates; with it both musl targets pass. `@junejs/inbox`
   needs the same.
3. **Install size is ~67 MB, not ~20 MB.** A fresh `npm install @opentui/core @opentui/react react`
   also installs auto-installed peers: `typescript` (23 MB, a peer of `bun-ffi-structs`),
   `react-devtools-core` (15 MB, a peer of `@opentui/react`) and `web-tree-sitter` (5.7 MB). The
   compiled binary does not pay this; `bunx @junejs/inbox` does.
4. **Emoji width depends on the terminal's width table.** Replayed with Unicode 11 widths
   (VS Code, Windows Terminal, current emulators) the screen is clean on every target; with
   Unicode 6 widths a stale cell follows `☕` (`☕r`) on every target. CJK text is unaffected and
   borders stay aligned. OpenTUI's width method was `unicode-wide` locally on macOS and `unicode`
   on every CI runner.
5. **Slow machines are slow, not stuck.** The Intel macOS runner renders at 13–15 ms a frame
   (others 4–7 ms) and once dropped to 9 events/s; the throughput floor is 5/s because a starved
   event loop drops to ~0. Windows timers tick every 15.6 ms, so the fake feed runs at ~16/s there.
6. **Layout**: Yoga defaults `flexShrink` to 0, so a flex child with long content pushes its
   siblings off screen unless it sets `flexShrink: 1, minHeight: 0`.
7. **Spawning on Windows**: npm makes `.cmd` shims, bun makes `.exe` shims; `cmd.exe` does not
   parse backslash-escaped quotes; Windows PowerShell 5.1 strips quotes from arguments to native
   commands (hence `--bin`).

## Still manual

- `$EDITOR` with a real editor: vim, and VS Code with `EDITOR="code --wait"`.
- Flicker by eye in a real terminal at 20 events/s while scrolling the trace (Ghostty, iTerm2,
  Terminal.app, Windows Terminal, VS Code).
