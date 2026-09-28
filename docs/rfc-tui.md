# RFC appendix: The TUI toolkit — OpenTUI vs Ink

Status: **proposal / draft** · Stage: v0 · Companion to `docs/rfc-email.md` §9.3, which decides
the operator client's shape: `@junejs/inbox` (bin `june-inbox`), an external subcommand behind
`june inbox`, shipped as a package and as compiled binaries, with OpenTUI pinned to an exact
version behind a thin component layer. This appendix records **why OpenTUI over Ink**, the
terminal conventions the TUI follows, and the spike that gates building it.

## Summary

The TUI is a live view over streams — the pending queue, thread traces, the `InboxEvent`
change feed. That is Ink's weakest case and OpenTUI's strongest, and OpenTUI's runtime floor
(Bun 1.3+ or Node 26.4+) costs June nothing: the `june` CLI already runs on Bun. Choose
**OpenTUI with `@opentui/react`**; keep Ink as the fallback the component layer makes cheap.

## 1. What the TUI has to do

From `docs/rfc-email.md` §9.3, and in general for any agent-supervision screen:

1. **Stay live.** Subscribe to a resumable SSE feed and update in place, without flicker, while
   the operator reads.
2. **Show long, growing content.** A thread with its `TurnTrace` (tool calls, results, reasoning
   summaries) is long and appended to while visible — it needs real scrolling, not reprinting.
3. **Keyboard triage loop.** Next / previous, approve, reject with a note, take over; edit a
   draft in `$EDITOR` and come back.
4. **Never own logic.** Every action is an API call; the `--json` subcommands and the TUI show
   the same records.

Requirements 1 and 2 decide the toolkit.

## 2. The candidates

Both are React renderers for the terminal with flexbox layout. They differ below that.

| | **Ink** | **OpenTUI** |
|---|---|---|
| Engine | JS React reconciler + Yoga layout (WASM, embedded as base64 in `yoga-layout` 3.2.1), writes ANSI strings | Native core in Zig (rendering, frame diff, buffers) with a TypeScript API |
| Framework bindings | React only | React (`@opentui/react`), Solid (`@opentui/solid`), or the imperative core API |
| Runtime (npm `engines`) | `node >=22`; runs on Bun | `bun >=1.3.0`, `node >=26.4.0` |
| Version (2026-09-28) | 7.1.1 — mature, stable API | 0.5.12 — pre-1.0, the API still moves |
| Used by | Claude Code, Gemini CLI, Copilot CLI, Wrangler, Shopify CLI | opencode |
| Frequent redraws, long output | Re-renders the tree to strings. By default rewrites the whole output; `incrementalRendering` (off by default) rewrites only changed **lines**. Flicker and slowdown on long, fast-changing trees are its best-known complaints | Native frame diff: only changed **cells** are written |
| Scrolling | Not built in; apps page through `<Static>` or roll their own | Built-in scroll container |
| Input | `useInput`, `useFocus`; limited mouse | Keyboard, mouse and scroll events built in |
| Screen mode | Inline by default; alternate screen optional | Alternate screen, mouse tracking on by default |
| Accessibility | Has a screen-reader mode | Not documented |
| Ecosystem | Large (text input, spinners, select, tables) | Small; most widgets we would write |
| Install size (macOS arm64) | ~1.4 MB (`ink` + `yoga-layout`) | ~19.6 MB (`@opentui/core` 14 MB + platform binary 5.4 MB) |
| Prebuilt platforms | n/a (JS + WASM, no platform-specific packages) | darwin x64/arm64, linux x64/arm64 (glibc + musl), win32 x64/arm64 |

### Verified 2026-09-28 (macOS arm64, Bun 1.3.14)

- Both render a bordered box with `@opentui/react` / `ink` + React 19.3 under Bun.
- `bun build --compile` of the OpenTUI program produces a working standalone binary (72 MB,
  almost all of it the Bun runtime); the native core is embedded, no side files.
- **Not yet verified**: Linux and Windows at runtime, the npm install path loading the native
  core from a user's `node_modules`, OpenTUI under Node 26.4+. See §5.

## 3. Why OpenTUI

1. **It fits the workload.** Requirements 1 and 2 — a live feed and long, growing traces — are
   exactly where Ink struggles (flicker and redraw cost on long, fast-changing output are its
   best-known complaints; `incrementalRendering` narrows the gap to a line diff) and what
   OpenTUI's native cell diff and scroll container are built for.
2. **No new runtime.** `june` already runs on Bun: `packages/cli/bin.mjs` probes for Bun and
   re-executes `src/june.ts` under it, and `@junejs/inbox` compiles with `bun build --compile`.
3. **React, as everywhere else in June.** The monorepo pins React 19 in the workspace catalog,
   and `@opentui/react` peers on `react >=19.2`. Screens are not shared with the web GUI (the
   host elements differ), but hooks, the API client, the `InboxEvent` cursor logic and the
   state reducers are.
4. **The risk is contained.** The TUI only talks to the operator API, and its views sit behind
   the thin component layer of `docs/rfc-email.md` §9.3. If OpenTUI stalls, moving to Ink
   rewrites views, not behavior.

Ink would be the right call if the TUI had to run on Node older than 26.4 (OpenTUI's floor),
if stable Windows or screen-reader support were first requirements, or if it were mostly
prompts and wizards rather than live streams. None of these hold for June today.

## 4. Terminal conventions

- **Open the TUI only when both stdin and stdout are TTYs.** Otherwise `june inbox` with no verb
  prints the pending listing and exits: a pipe gets text, and a redirected or closed stdin never
  leaves a full-screen UI that cannot read keys.
- **Alternate screen** for the triage loop (it is a full-screen app); leave the scrollback as it
  was on normal exit, Ctrl-C, SIGTERM / SIGHUP and uncaught errors (restore modes in a
  `finally`, in signal handlers and in an `uncaughtException` hook). SIGKILL and a native-core
  abort cannot be caught; `reset` recovers the terminal, and the TUI says so in `--help`.
- **Suspend for `$EDITOR`** with `renderer.suspend()`, spawn the editor with inherited stdio,
  then `renderer.resume()` — never destroy and re-create the renderer, which would remount
  components, drop their state and re-open the change-feed subscription. Verified 2026-09-28:
  a child process with inherited stdio runs between `suspend()` and `resume()`, and the React
  tree is not remounted. The spike still proves it with real editors (§5).
- **Keys first, mouse optional.** Every action has a key; mouse only adds click and wheel.
- **Width and CJK**: bodies are user mail in any language; wide characters and emoji must not
  break borders or columns; never assume one locale or script.
- **Color**: respect `NO_COLOR` and degrade on 16-color terminals.

## 5. Spike before building (half a day, gates P1c)

A throwaway prototype — a scrolling list fed by a fake SSE stream at 20 events/s, a detail pane
with a 2 000-line trace — checked on every target `@opentui/core` ships a prebuilt for and
§9.3's CI smoke test covers:

- [ ] Renders, resizes and restores the terminal on exit and on Ctrl-C on all eight prebuilt
      targets: macOS x64 and arm64; Linux x64 and arm64, each on glibc and on musl (e.g.
      Alpine); Windows x64 and arm64.
- [ ] Every install path of §9.3 loads the native core: `bunx @junejs/inbox`, a global install,
      `june inbox` delegating inside a project, and the `bun build --compile` binary.
- [ ] Falls back to text when stdin or stdout is not a TTY.
- [ ] `$EDITOR` suspend / resume round-trip, with vim and with VS Code (`code --wait`).
- [ ] CJK and emoji in list rows and borders.
- [ ] No visible flicker or lag at 20 events/s while scrolling the trace.

If a box fails and cannot be fixed upstream quickly, re-run the same prototype on Ink with
`incrementalRendering: true` before building further — the component layer keeps that cheap.

## 6. Open questions

1. **Accessibility.** If a screen-reader user needs the operator surface, are the `--json` and
   plain-text subcommands the supported path, or do we need a TUI mode for it?
2. **Other TUIs.** Should `june dev` gain a TUI dashboard (routes, requests, agent turns) on the
   same component layer, or stay a plain log stream?
