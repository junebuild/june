---
"@junejs/core": minor
"@junejs/server": minor
---

Agents can answer with files (docs/rfc-agent-files.md).

- A tool stores what it produces with `ctx.files.put(bytes, { name, mediaType })` and returns the `FileRef` it gets back (alone, or anywhere in its result). Only the ref enters the session log; the bytes live in a `FileStore`. Ids are SHA-256 content addresses, so a retried tool writes the same file again rather than a second one.
- The turn emits `file.attached` (`{ turnId, callId, file }`) after the tool's `action.completed`, live and on `observe({ replay: true })`.
- `slackChannel` uploads attached files into the reply's thread after the reply text (streamed, post-once, `deliver` and `deliverResume`). Add the **`files:write`** scope to your Slack app; a failed upload is reported through `onError` and noted in the thread.
- Where files live: `june dev` uses the app's `resources.blob`, or `.june/blob` when none is declared. `createAgentRuntime` / `createNativeRuntime` / `MemoryRuntime` take a `files` option, and `mountAgent` passes it to the channels. `AgentDurableObject` uses `DoAgentDef.files`, else the `blob` of its `resources` (under `agent-files/`); `durableChannelSurface` takes `files` for worker-side rendering. Without a store, `ctx.files.put` fails the turn and says what to configure.
- New exports in `@junejs/core/agent-files`: `FileRef`, `FileStore`, `blobFileStore`, `memoryFileStore`, `isFileRef`, `fileRefsIn`. `ChannelContext.files` and the `files` option of `deliver` / `deliverResume` let custom channels deliver files too.

Upgrade `@junejs/core` and `@junejs/server` together: the runtime contract version moves to 7, and a server that resolves an older core fails at startup and names both versions.
