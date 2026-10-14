---
title: "Files: answering with a PDF"
nav: "Files & PDF"
description: A tool stores the file it produces with ctx.files and returns the FileRef; the turn emits file.attached and the channel delivers it — a Slack upload into the thread. @junejs/pdf builds PDF output on it with a replaceable renderer.
date: 2026-10-12
section: Agents
order: "16.35"
sources: [packages/core/src/agent-files.ts, packages/core/src/agent-runtime.ts, packages/core/src/agent-config.ts, packages/core/src/channels.ts, packages/june/src/agent-native.ts, packages/june/src/agent-durable.ts, packages/june/src/app.ts, packages/pdf/src/tools.ts, packages/pdf/src/renderer.ts, packages/pdf/src/typst.ts, packages/pdf/src/markdown-typst.ts, packages/pdf-typst-wasm/src/renderer.ts, packages/pdf-typst-wasm/src/workerd.ts, packages/pdf-typst-wasm/src/lib.rs, packages/pdf/skills/pdf-report.md, docs/rfc-agent-files.md]
---
## A PDF in a Slack thread

Ask the agent in Slack for "last week's revenue as a PDF" and it replies in the thread with a
short summary and the PDF attached. Two pieces make that work: a tool and a skill.

```ts
// agent/tools/pdf.ts
import { pdfTools } from "@junejs/pdf";
import { typstRenderer } from "@junejs/pdf/typst";

export default pdfTools({ renderer: typstRenderer() });
```

```bash
bun add @junejs/pdf @myriaddreamin/typst.ts @myriaddreamin/typst-ts-web-compiler
cp node_modules/@junejs/pdf/skills/pdf-report.md agent/skills/
```

The `render_pdf` tool takes Markdown, which the model writes well. The `pdf-report` skill
teaches the model to gather the data first, put figures in tables, render once, and reply
with a short note instead of pasting the document. Your Slack app needs the `files:write`
scope.

## Files as turn output

Any tool can produce a file. It stores the bytes and returns the ref it gets back:

```ts
// agent/tools/export_csv.ts
import type { Tool } from "@junejs/core/agent-runtime";

const exportCsv: Tool = {
  spec: { name: "export_csv", description: "Export the orders as CSV", input: { type: "object" } },
  run: async (_input, ctx) => {
    const csv = new TextEncoder().encode("id,total\n1,42\n");
    const file = await ctx.files.put(csv, { name: "orders.csv", mediaType: "text/csv" });
    return { file, rows: 1 };
  },
};
export default exportCsv;
```

- Only the `FileRef` (`{ $june: "file", id, name, mediaType, size }`) enters the session
  log and the model's context. The bytes stay in a `FileStore`.
- Ids are SHA-256 content addresses. A remote tool runs at least once, so a retried
  render writes the same file again rather than a second one.
- After the tool's `action.completed`, the turn emits `file.attached` for every ref in the
  result. It is folded back on `observe({ replay: true })`.
- `slackChannel` uploads each attached file into the reply's thread after the reply text.
  A failed upload is reported through `onError` and noted in the thread; the turn has
  already completed.

A file tool is a plain `Tool`, not a `defineAction`: `ctx.files` lives on the tool context,
and an action receives only the caller's identity.

## Where files live

| host | store |
| --- | --- |
| `june dev` | the app's `resources.blob`, else `.june/blob` |
| `createAgentRuntime` / `createNativeRuntime` | the `files` option |
| `AgentDurableObject` | `DoAgentDef.files`, else the `blob` of its `resources`, under `agent-files/` |

Files are kept for delivery, not as an archive. `memoryFileStore` drops the least recently
used files past 64 MiB (`maxBytes`). The blob store never deletes, because content-addressed
files may be shared between turns: expire them with an R2 lifecycle rule on the
`agent-files/` prefix (a few days covers redelivery), and clear `.june/blob/agent-files/` in
development.

`mountAgent` and `durableChannelSurface` pass the store to the channels
(`ChannelContext.files`), and host-side delivery passes it to `deliver` /
`deliverResume`. Without a store, `ctx.files.put` fails the turn and says what to configure.

## Choosing a PDF renderer

`pdfTools` depends only on the `PdfRenderer` interface, so the engine is your choice:

```ts
import type { PdfRenderer } from "@junejs/pdf";

const browserRenderer: PdfRenderer = {
  name: "browser",
  async render({ markdown, title }) {
    const res = await fetch("https://pdf.internal.example/render", { method: "POST", body: JSON.stringify({ markdown, title }) });
    return new Uint8Array(await res.arrayBuffer());
  },
};
```

Two renderers ship with June. Both typeset the same Markdown → Typst source, so the
PDF looks the same with either.

### On Cloudflare Workers: `@junejs/pdf-typst-wasm`

```ts
// agent/tools/pdf.ts
import { pdfTools } from "@junejs/pdf";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

export default pdfTools({ renderer: typstWasmRenderer() });
```

The package is a build of Typst and its PDF export only, compiled to WebAssembly (29 MiB,
zero imports). It runs on Workers as well as Node, Bun and Deno. On Workers the module is
imported, so it uploads precompiled.

Measured on a deployed Worker: 2 ms startup, about 40 ms of CPU for a warm one-page render,
and about 670 ms for 18 pages. Use Workers Paid: the Free plan's 10 ms of CPU is not enough.

- **One engine per isolate.** It is created on the first render (about 200 ms of CPU) and
  serves every later request. An isolate's requests share 128 MB of memory.
- **Fonts:**
  - Typst's own fonts are built in.
  - `fonts: [...]` registers yours once.
  - Per document, the renderer fetches Noto Sans TC from Google Fonts, cut to that
    document's non-ASCII characters (a few KB each). This is how Traditional Chinese works
    with no setup. Change the families with `googleFonts: [{ family, weights }]`, or make
    no network call at all with `googleFonts: false`.
  - A character no loaded font covers (an emoji, or CJK with `googleFonts: false` or a
    failed fetch) fails the render with a `PdfRenderError` naming it, so the model can drop
    a decorative symbol or tell the user. `onMissingGlyphs: "warn"` logs it and renders the
    character blank instead.

### Anywhere but Workers: `typstRenderer`

`typstRenderer()` typesets on the Typst compiler built for WebAssembly, in process. It
loads on the first render (measured: about half a second, once per process), then takes
tens of milliseconds per page.

- It is verified on Bun and Node. On Workers, use `@junejs/pdf-typst-wasm` instead: it is
  smaller, has no JS glue, and is verified there.
- Fonts: by default it fetches typst.ts's hosted Latin fonts and a Simplified Chinese
  font. Traditional Chinese, Japanese and Korean need a font that covers them:
  `typstRenderer({ fonts: [notoSansTcBytes], fontFamilies: ["Noto Sans TC"] })`. Pass
  `fontAssets: false` to make no network call at all.
- Markdown images render as their alt text: the compiler has no network access.
