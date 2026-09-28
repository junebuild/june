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
- `harness/installed.ts <path>` — packs the spike, installs the tarball the way a user would, and
  runs the harness against the bin that install made: `npm` / `bun` (a fresh project),
  `npm-global` / `bun-global` (into a temporary prefix), `bunx`. Not covered: `june inbox`
  delegation, which does not exist yet.

```sh
bun install
bun harness/run.ts                          # from source
bun build --compile src/main.tsx --outfile dist/tui-spike
bun harness/run.ts --bin dist/tui-spike     # the compiled binary
bun harness/installed.ts npm                # npm install of the packed tarball
bun harness/installed.ts bun                # also: npm-global, bun-global, bunx
```

## What the harness checks

| scenario | checks |
|---|---|
| session | renders; feed live; CJK on screen; box borders in the same columns on every row; no stale cells after emoji (Unicode 11 widths); no full-screen clears and ≥ 5 events/s while keys are pressed (a starved event loop drops to ~0); the selected row stays on screen while events are prepended above it (≥ 18 of 20 samples); `$EDITOR` runs with the terminal and the TUI comes back; resize 120x40 and 60x20; `q` exits 0; terminal restored; mounted once, one feed subscription, suspend/resume paired |
| typeahead | `q` sent the instant the process starts, before the first frame: exits 0 and restores the terminal |
| typeahead nav | `j` sent the instant the process starts: once the list has data, a row is selected (it stays put while events stream in) |
| ctrl-c, crash, sigterm | exits 130 / 1 / 143 and restores alternate screen, cursor and mouse modes (sigterm skipped on Windows) |
| stdin redirected | stdout a TTY, stdin `/dev/null` or `NUL`: no full-screen UI, prints the listing, exits 0 |
| no TTY | pipes only: plain text, five lines, exits 0 |

Reported but not asserted: frame times, PTY bytes/s, `widthMethod`, and stale cells when the same bytes
are replayed with Unicode 6 widths (a stand-in for legacy `wcwidth` tables).

## Results

CI run [36467382075](https://github.com/junebuild/june/actions/runs/36467382075) (2026-09-28,
OpenTUI 0.5.12, Bun 1.4.2 on every target). Windows runs 48 checks: SIGTERM is skipped. Alpine
has no npm, so musl has no npm or npm-global column.

| target | source | compiled | npm | bun | npm-global | bun-global | bunx | frame avg / max | events/s |
|---|---|---|---|---|---|---|---|---|---|
| darwin-arm64 | ✅ 53/53 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 1.8 / 16.5 ms | 19 |
| darwin-x64 | ✅ 53/53 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 6.3 / 46.9 ms | 17 |
| linux-x64 | ✅ 53/53 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 2.1 / 17.0 ms | 18 |
| linux-arm64 | ✅ 53/53 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 1.7 / 12.6 ms | 17.5 |
| linux-x64-musl | ✅ 53/53 | ✅ | — | ✅ | — | ✅ | ✅ | 2.4 / 14.7 ms | 18 |
| linux-arm64-musl | ✅ 53/53 | ✅ | — | ✅ | — | ✅ | ✅ | 1.7 / 10.9 ms | 17.5 |
| win32-x64 | ✅ 48/48 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 2.1 / 15.0 ms | 18.5 |
| win32-arm64 | ✅ 48/48 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 2.0 / 16.6 ms | 17.5 |

Every ✅ is the full check count for that target. Frame times are from the source path and vary
between runs on the same Bun: earlier 1.4.2 runs averaged 1.1–5.5 ms, 4.3–11.2 ms on the Intel
macOS runner.

On Bun 1.3.14 (run [36460069360](https://github.com/junebuild/june/actions/runs/36460069360))
the same checks passed everywhere except Windows arm64, where the native core does not load
(finding 1), and frames were slower: 5–8 ms average.

Also verified by hand: darwin-arm64 (MacBook Air M3) and win32-x64 (starship-win11 over SSH),
2026-09-28 — the first four paths on Bun 1.3.14, all seven on darwin-arm64 with Bun 1.4.2.

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
7. **A live list must anchor its selection in a layout effect, from the data.** New events are
   prepended, pushing an older selection down ~20 rows/s. Scrolling in `useEffect` left the row
   off screen in 2–11 of 20 samples: the passive effect runs after OpenTUI has drawn a frame
   with the row inserted. `scrollChildIntoView` in `useLayoutEffect` was off screen 20 of 20:
   at commit time the new rows are not laid out, so it scrolls one row short. Setting `scrollTop`
   from the row's index in `useLayoutEffect` holds it 20 of 20 (six runs). The list also never
   evicts the selected event at its 500-row cap.
8. **Keys typed during startup are lost unless buffered.** OpenTUI emits keys from the moment the
   renderer exists, but `useKeyboard` subscribes in an effect: a `q` sent before the first frame
   (~80 ms) reached no listener 5 of 5 times, while a listener on `renderer.keyInput` attached
   right after `createCliRenderer` saw it 5 of 5. On the slow Intel macOS runner the gap reached
   past the first frame and dropped the harness's crash key once. Buffering and replaying is not
   enough: a replayed `j` meets an empty list, since the first event has not arrived, and is
   spent on nothing — as is a live `j` in that window. So `main.tsx` buffers keys until `App` has
   subscribed; quit keys then act at once, and every other key waits until the list has data and
   runs in order (`move` is a functional update, so queued moves compose). The `typeahead`
   check fails without the buffer, `typeahead nav` without the queue (3 of 3 each).
9. **Spawning on Windows**: npm makes `.cmd` shims, bun makes `.exe` shims; `cmd.exe` does not
   parse backslash-escaped quotes; Windows PowerShell 5.1 strips quotes from arguments to native
   commands (hence `--bin`).

## Still manual

- `$EDITOR` with a real editor: vim, and VS Code with `EDITOR="code --wait"`.
- Flicker by eye in a real terminal at 20 events/s while scrolling the trace (Ghostty, iTerm2,
  Terminal.app, Windows Terminal, VS Code).
