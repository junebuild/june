# RFC: Agent files — a turn can answer with a file

Status: **proposal / in progress** · Stage: v0 (no back-compat constraint) · Scope: the turn
engine (`ToolContext`, `TurnEvent`), the channel contract, `slackChannel`, the native and
Durable Object hosts, and a new `@junejs/pdf` package.

## Summary

Today a turn's output is text. A tool's result is JSON in the durable log, the engine streams
`message.delta` / `message.completed`, and a channel posts text. An agent asked "summarize last
week's revenue as a PDF" in Slack has no way to answer with the PDF.

This RFC adds **files as turn output**, as a primitive every capability can use, and then ships
**PDF as the first capability** built on it — a tool plus a skill, not a framework feature:

```ts
// agent/tools/pdf.ts
import { pdfTools } from "@junejs/pdf";
import { typstRenderer } from "@junejs/pdf/typst";
export default pdfTools({ renderer: typstRenderer() });
```

```
user  @bot summarize last week's revenue as a PDF
 → slackChannel → durable turn
 → model: read_skill("pdf-report"), query tools, render_pdf({ markdown, filename })
     → renderer → bytes → ctx.files.put() → FileRef   (bytes in the blob store, ref in the log)
     → engine emits file.attached
 → model: "The report is attached; revenue grew 12%…"   (streamed to the thread)
 → turn.completed → the Slack renderer uploads the PDF into the same thread
```

## 1. The primitive: `FileRef`, `FileStore`, `ctx.files`

- **`FileRef`** is the JSON a tool returns for a file:
  `{ $june: "file", id, name, mediaType, size }`. It is what the durable log and the model see.
  **Bytes never enter the messages log**: the log must stay small and replayable, and a model
  has no use for a PDF's bytes.
- **`FileStore`** is the seam that holds the bytes: `put(data, { name, mediaType })` →
  `FileRef`, and `get(id)` → bytes or null. `blobFileStore(blob)` implements it over the
  existing `JuneBlob` resource (local directory in dev, R2 on Cloudflare), under a
  `agent-files/` prefix.
- **Content-addressed ids** (SHA-256 of the bytes). A remote tool runs at-least-once; a retry
  that renders the same bytes writes the same key, so a crash-replay never leaves orphans or
  duplicates.
- **`ctx.files`** is on every `ToolContext`. The host installs the store on the session; a
  session without one hands tools a store whose `put` fails the turn with a message naming the
  missing configuration (a misconfigured deployment, not something the model can fix).

## 2. The event: `file.attached`

After `action.completed`, the engine emits `{ type: "file.attached", turnId, callId, file }`
for each `FileRef` in the tool's result (the result itself, or nested in arrays and plain
objects a few levels down). It is a **structural** event: derived from the tool message in the
log, so `observe({ replay: true })` folds it back like `action.completed`. No new durable state.

A tool that returns a `FileRef` is the whole contract — a tool author does not emit events, and
a channel author reads one event type instead of scanning arbitrary tool results.

## 3. Channels deliver files

A channel reads bytes through the same `FileStore`, which the host hands it on
`ChannelContext.files` (the inbound webhook path) and on `deliver`'s options (host-side
delivery). Each channel decides how a file arrives:

| channel | delivery |
| --- | --- |
| Slack | `files.getUploadURLExternal` → POST the bytes → `files.completeUploadExternal` with `channel_id` + `thread_ts`. Needs the `files:write` scope; `diagnose()` checks it |
| Crisp | a `"file"` message pointing at a signed URL (later) |
| HTTP / SSE | the `file.attached` event, with a download URL (later) |
| MCP | an embedded resource or `resource_link` in the tool result (later) |

Slack uploads after the reply text, so the attachment lands under the answer that describes
it. A file whose upload fails is reported through `onError` and noted in the thread; it never
fails the turn, which already completed.

**Idempotency.** Slack redelivers events, and a resume re-renders. Uploads are keyed by
(turn, file id) per render, so one render never posts the same file twice; cross-render
dedupe rides the existing event-id dedupe (#170).

## 4. `@junejs/pdf`: a capability, with a replaceable renderer

```ts
export interface PdfRenderer {
  readonly name: string;
  render(doc: PdfDocument): Promise<Uint8Array>;
}
export type PdfDocument = { markdown: string; title?: string; author?: string; lang?: string; paper?: "a4" | "us-letter" };
```

- **Input is Markdown.** It is what models write best and what a skill can teach in a page.
- **`pdfTools({ renderer })`** returns the `render_pdf` tool: Markdown in, `FileRef` out.
  The package also ships a skill file (`skills/pdf-report.md`) an app copies into
  `agent/skills/`.
- **The renderer is the app's choice**, behind `PdfRenderer`. The first one is
  **`typstRenderer()`**: Markdown → Typst markup → PDF, on the Typst compiler compiled to WASM
  (`@myriaddreamin/typst.ts`). Others (Cloudflare Browser Rendering, Playwright, a remote
  service) implement the same interface.

### Typst WASM, measured (verified 2026-10-12, Bun 1.3.14, typst.ts 0.7.0, starship)

| | |
| --- | --- |
| compiler WASM | 28.3 MB raw, 10.8 MB gzip |
| init (incl. default text + CJK font assets from jsdelivr) | ~550 ms, once per process |
| compile a one-page document with a table | ~26 ms |
| output | 14 KB, fonts subset and embedded |

Consequences:

- **Not on Cloudflare Workers.** 10.8 MB gzip exceeds the Workers bundle limit. On Workers,
  pick another renderer — the reason the interface exists.
- **Fonts are the renderer's job.** typst.ts's bundled CJK asset is a Simplified Chinese
  subset and lacks Traditional characters (週 was missing in the test). `typstRenderer`
  accepts font bytes or URLs; Traditional Chinese needs e.g. Noto Sans TC.
- **Lazy load.** The compiler is imported and initialized on the first render, so an agent
  that never renders a PDF never pays for it.

## 5. Non-goals (for now)

- A `.pdf` route projection (`/invoice.pdf`). The `PdfRenderer` seam is reusable for it later.
- Files as turn *input* (a user uploading a PDF to the agent).
- Signed download URLs and a file-serving endpoint (needed by Crisp / HTTP / MCP delivery).

## 6. Phasing

1. Core: `FileRef`, `FileStore`, `blobFileStore`, `memoryFileStore`.
2. Engine: `ctx.files`, `AgentSession.files`, `file.attached` (live and folded).
3. Hosts: the native runtime and the Durable Object install a store; channels receive it.
4. Slack: upload attached files into the reply's thread.
5. `@junejs/pdf`: `PdfRenderer`, `pdfTools`, `typstRenderer`, the skill.
6. Example and docs.
