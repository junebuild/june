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
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";
export default pdfTools({ renderer: typstWasmRenderer() });
```

(Updated 2026-10-13: the typst.ts-based `typstRenderer` this RFC first shipped was removed in
favor of `@junejs/pdf-typst-wasm`, which runs on every host. See the note in §4.)

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
- **Retention.** A file is needed until its channel delivered it, and after that only to
  deliver it again. `memoryFileStore` is bounded (64 MiB by default, least recently used files
  go first). `blobFileStore` never deletes: ids are content addresses that several turns may
  share, so how long files live is a deployment setting — an R2 lifecycle rule expiring
  `agent-files/` objects after a few days, or clearing `.june/blob/agent-files/` in dev.
- **`ctx.files`** is on every `ToolContext`. The host installs the store on the session; a
  session without one hands tools a store whose `put` fails the turn with a message naming the
  missing configuration (a misconfigured deployment, not something the model can fix).

## 2. The event: `file.attached`

After `action.completed`, the engine emits `{ type: "file.attached", turnId, callId, file }`
for each `FileRef` in the tool's result (the result itself, or nested in arrays and plain
objects a few levels down). It is a **structural** event: derived from the tool message in the
log, so `observe({ replay: true })` folds it back like `action.completed`. No new durable state.

Delivery keys off the live event, so the engine records that a step's files were announced.
A crash after the tool committed but before the emission leaves no record, and the replay
announces them at turn start; a resume after a park finds the record and does not announce
files already delivered above the approval prompt. This is at-least-once: a crash between the
emission and the record announces them twice.

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
| compiler WASM | 28.3 MB raw (10.8 MB gzip) |
| init (incl. default text + CJK font assets from jsdelivr) | ~550 ms, once per process |
| compile a one-page document with a table | ~26 ms |
| output | 14 KB, fonts subset and embedded |

Consequences:

- **Cloudflare Workers: the size fits, and memory is the constraint.** Workers allow 64 MiB
  per Worker, uncompressed, on Free and Paid alike (developers.cloudflare.com/workers/platform/limits,
  read 2026-10-12; there is no compressed limit). What binds is memory: an isolate's
  concurrent requests share 128 MB, and a render takes 13–40 MB of WASM memory. CPU binds
  too: the Free plan allows 10 ms per request, and one page compiles in 12–28 ms. A spike
  of a PDF-only build without typst.ts's IDE features (Appendix A) is 18.9 MiB and renders a
  page in 66–98 ms end to end on local workerd. `typstRenderer` itself is not yet verified
  on workerd.
- **Fonts are the renderer's job.** typst.ts's bundled CJK asset is a Simplified Chinese
  subset and lacks Traditional characters (週 was missing in the test). `typstRenderer`
  accepts font bytes or URLs; Traditional Chinese needs e.g. Noto Sans TC.
- **Lazy load.** The compiler is imported and initialized on the first render, so an agent
  that never renders a PDF never pays for it.

### The Workers renderer: `@junejs/pdf-typst-wasm`

A second renderer, built for Cloudflare Workers. It is `typst` + `typst-pdf` compiled to
wasm32 with a raw C ABI, so it has none of typst.ts's editor features and no wasm-bindgen glue.
Appendix A has the spike's measurements.

| | |
| --- | --- |
| module | 29 MiB raw with Typst's default fonts embedded, zero imports |
| Worker startup (deployed) | 2 ms: the module is imported, so it uploads precompiled |
| CPU per render (Workers Logs) | ~200 ms for an isolate's first, ~40 ms warm, ~670 ms for 18 pages |

Design:

- One engine per isolate.
- CJK fonts are per-document Google Fonts subsets. They are document-scoped in the engine, so
  they never accumulate across requests.

**Update 2026-10-13 (#368, #371).** This is now June's only renderer: `typstRenderer` was
removed because typst.ts embeds no fonts (even Latin text needed a jsdelivr fetch, so it could
not render offline) and exposes no laid-out frames to check glyph coverage on. Fonts became
providers (`fonts: [localFonts(…), googleFontSubsets(…)]`), each declaring its egress; the
default is offline with the embedded fonts only, and a character no loaded font covers is a
`PdfRenderError` instead of a blank.
- The `workerd` export condition imports the module; Node, Bun and Deno read it from disk.
- CI builds it with the pinned Rust toolchain and binaryen, runs `cargo test` and the JS
  tests, and serves the published shape on workerd.

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
7. `@junejs/pdf-typst-wasm`: the PDF-only engine for Workers, built and published by CI.

## Appendix A. The Workers spike, measured

Before `@junejs/pdf-typst-wasm` existed, a spike measured whether a PDF-only Typst build
fits Cloudflare Workers. It was `typst` 0.15.1 + `typst-pdf` behind a raw C ABI, with an
in-memory World and fonts supplied by the host. The spike's code became
`packages/pdf-typst-wasm`. To reproduce: its `scripts/smoke-workerd.ts` serves the package
on local workerd, and for production numbers, deploy a Worker around it and read CPU time
from Workers Logs. All numbers below were verified 2026-10-12 on starship (Ryzen 7 8745HS).

**Cloudflare's limits.** Read from developers.cloudflare.com/workers/platform/limits on
2026-10-12; the page says it was updated the same day.

| limit | value |
| --- | --- |
| Worker size | 64 MiB uncompressed, Free and Paid. There is no compressed limit: wrangler's gzip figure is informational |
| memory | 128 MB per isolate, shared by its concurrent requests, JS heap and WASM together |
| CPU per request | Free: 10 ms. Paid: 30 s by default, up to 5 min |
| startup | the global scope must run within 1 s |

**Size.** Both builds are far below 64 MiB. Of the optimized spike module, about 10.0 MB is
code and 9.2 MB is data. The shipped package also embeds Typst's default fonts, which
brings it to 29 MiB.

| build | raw | gzip | brotli |
| --- | --- | --- | --- |
| typst.ts 0.7.0 web compiler (typst 0.14.2; `@junejs/pdf/typst`) | 28.3 MB | 10.8 MB | 7.1 MB |
| spike, cargo `opt-level=z`, LTO, `panic=abort` | 21.3 MB | 7.8 MB | 5.9 MB |
| + `wasm-opt -Oz` | 19.3 MB | 7.7 MB | 6.0 MB |
| wrangler `deploy --dry-run` (whole Worker) | 18,894 KiB | 7,528 KiB | — |

**Local workerd** (`wrangler dev` 4.144.0). `subset` means Noto Sans TC cut to the
document's characters by Google Fonts (1.1 MB of fonts); `full` means the whole 19 MB Noto
Sans CJK collection (20.6 MB of fonts in total).

| | fonts | instance + fonts | compile | WASM memory | end to end |
| --- | --- | --- | --- | --- | --- |
| 1 page, `subset` | 40–73 ms | 4–7 ms | 12–15 ms | 13 MB | 66–98 ms |
| 1 page, `full` | first request only | ~50 ms | 23–28 ms | 32 MB | 80–124 ms |
| 18 pages zh-TW + tables, `subset` | 40–170 ms | 3–5 ms | 287–317 ms | 40 MB | 345–497 ms |

- The isolate's first request took 514 ms, including compiling the WASM and fetching fonts.
- Node 24 shows the same picture: WASM compile 23 ms, instantiate plus 4 fonts 52 ms, first
  compile 65 ms, then about 2 ms for an unchanged document (comemo memoization).
- The PDFs embed subset fonts with ToUnicode maps, so text extracts. Traditional Chinese
  renders (週, 區) with Noto Sans TC or Noto Sans CJK.

**Production.** Deployed with `cf deploy` 1.0.0-beta.13 to workers.dev. Requests came from
starship and were served by DFW. CPU and wall time come from Workers Logs
(`cf o11y telemetry query`). The Worker was deleted afterwards.

| | n | CPU min / median / max | wall |
| --- | --- | --- | --- |
| 1 page, `subset`, a fresh isolate | 2 | 185–211 ms | 381–516 ms |
| 1 page, `subset`, a warm isolate | 1 | 40 ms | 73 ms |
| 1 page, `full` | 14 | 116 / 295 / 644 ms | 0.56–4.2 s |
| 18 pages zh-TW + tables, `subset` | 15 | 403 / 670 / 1,690 ms | 0.66–2.9 s |

- Startup time was 2 ms. The WASM is compiled at upload, not in the global scope.
- 12 concurrent `full` renders, then 12 concurrent 18-page renders: all 24 answered 200,
  and all 35 logged invocations ended `ok`, none over the memory limit. Cloudflare spread
  them over several isolates, so this does not show that 12 renders fit in one isolate's
  128 MB.
- Production CPU was about twice starship's for the same compile, and an isolate's first
  render cost about 170 ms more, which fits the WASM being compiled on first use.
- In production `Date.now()` does not advance during CPU work, so a Worker cannot time its
  own compile. Workers Logs is the source of truth.

**Conclusions,** which `@junejs/pdf-typst-wasm` is built on:

- Size is not the constraint.
- Memory is: use one engine per isolate, register fonts once, and cut CJK fonts to the
  document's characters.
- CPU rules out the Free plan.
- An isolate's first render is the expensive one, so keep the engine.

**Not measured:** peak memory of one isolate running several renders at once, and what fills
the 9.2 MB data section.
