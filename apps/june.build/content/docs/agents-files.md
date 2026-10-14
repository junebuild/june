---
title: "Files: answering with a PDF"
nav: "Files & PDF"
description: A tool stores the file it produces with ctx.files and returns the FileRef; the turn emits file.attached and the channel delivers it — a Slack upload into the thread. @junejs/pdf builds PDF output on it with a replaceable renderer.
date: 2026-10-12
section: Agents
order: "16.35"
sources: [packages/core/src/agent-files.ts, packages/core/src/agent-runtime.ts, packages/core/src/agent-config.ts, packages/core/src/channels.ts, packages/june/src/agent-native.ts, packages/june/src/agent-durable.ts, packages/june/src/app.ts, packages/pdf/src/tools.ts, packages/pdf/src/renderer.ts, packages/pdf/src/markdown-typst.ts, packages/pdf-typst-wasm/src/renderer.ts, packages/pdf-typst-wasm/src/fonts.ts, packages/pdf-typst-wasm/src/assets.ts, packages/pdf-typst-wasm/src/unbundled.ts, packages/june/src/assets.ts, packages/pdf-typst-wasm/src/workerd.ts, packages/pdf-typst-wasm/src/bun.ts, packages/pdf-font-noto-sans-tc/src/provider.ts, packages/pdf-font-noto-sans-tc/src/unbundled.ts, packages/pdf-font-noto-sans-tc/src/workerd.ts, packages/pdf-typst-wasm/src/lib.rs, packages/pdf/skills/pdf-report.md, docs/rfc-agent-files.md]
---
## A PDF in a Slack thread

Ask the agent in Slack for "last week's revenue as a PDF" and it replies in the thread with a
short summary and the PDF attached. Two pieces make that work: a tool and a skill.

```ts
// agent/tools/pdf.ts
import { pdfTools } from "@junejs/pdf";
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

export default pdfTools({
  renderer: typstWasmRenderer({
    // Chinese text needs a font. This one ships in the package (~11 MB) and renders offline;
    // googleFontSubsets is a few KB per document instead, but sends each document's
    // characters to Google (see "Fonts" below).
    fonts: [notoSansTC()],
  }),
});
```

```bash
bun add @junejs/pdf @junejs/pdf-typst-wasm @junejs/pdf-font-noto-sans-tc
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

June's renderer is `@junejs/pdf-typst-wasm`.

### `@junejs/pdf-typst-wasm`

```ts
// agent/tools/pdf.ts
import { pdfTools } from "@junejs/pdf";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

export default pdfTools({ renderer: typstWasmRenderer() });
```

The package is a build of Typst and its PDF export only, compiled to WebAssembly (29 MiB,
zero imports). It runs on Node, Bun, Deno and Cloudflare Workers. On Workers the module is
imported, so it uploads precompiled. On Bun it is imported as a file, so `bun build --compile`
embeds it in the binary with no configuration. Other bundlers that produce a single file need
the module passed in: `typstWasmRenderer({ wasm: () => loadTheModule() })`.

Measured on a deployed Worker: 2 ms startup, about 40 ms of CPU for a warm one-page render,
and about 670 ms for 18 pages. Use Workers Paid: the Free plan's 10 ms of CPU is not enough.

- **One engine per process or isolate.** It is created on the first render (about 200 ms
  of CPU) and serves every later request. On Workers an isolate's requests share 128 MB of
  memory.
- Markdown images render as their alt text: the engine has no file or network access.

### Fonts

Where a PDF's fonts come from decides where its text goes, so the renderer makes no network
call unless you choose a font provider that does:

| `fonts` | what it costs | network |
|---|---|---|
| (none, the default) | Typst's built-in Latin, Greek and Cyrillic fonts only | none |
| `notoSansTC()` (`@junejs/pdf-font-noto-sans-tc`) | Traditional Chinese, regular and bold: ~11 MB in the package, registered once | none |
| `localFonts([bytes, url, loader])` | you supply the files (a CJK family is tens of MB) | a URL is fetched once; nothing about documents is sent |
| `googleFontSubsets({ families })` | a few KB per document | **each document's non-ASCII characters** go to fonts.googleapis.com and fonts.gstatic.com (the subset's URL encodes them) |

`notoSansTC()` covers 17,755 Han characters, including every Big5 one; a rarer character is
reported like any other missing glyph. On Bun, `bun build --compile` embeds its files. On
Workers they upload with the Worker (with the engine, about 40 of the 64 MiB a Worker may
be) as Data modules. `june build` adds the wrangler rule that loads them; if you keep your
own wrangler config, it warns until you add it, and without it the deploy fails with "No
loader is configured for .otf files":

```jsonc
// wrangler.jsonc
"rules": [{ "type": "Data", "globs": ["**/*.otf"], "fallthrough": true }]
```

Providers combine: `fonts: [localFonts([brandFont]), googleFontSubsets(…)]`. Their order
doesn't set preference: `fontFamilies: ["Noto Sans TC"]` does, and for a character those
families lack, Typst falls back to the most similar loaded font that has it.

A character no loaded font covers (an emoji, or CJK with no CJK font) fails the render with
a `PdfRenderError` naming it, along with any provider that failed to load. `render_pdf`
hands it to the model, which can drop a decorative symbol or tell the user. Pass
`onMissingGlyphs: "warn"` to render those characters blank and log them instead.

`renderer.egress` lists every host the configured providers contact and what each is sent
(with the unbundled entry, the engine's hosts too; see below), for a setup check or your own
docs:

```ts
const renderer = typstWasmRenderer({ fonts });
renderer.egress; // [] when offline, or [{ host: "fonts.googleapis.com", sends: "document-characters" }, …]
```

The providers declare it themselves; it is not a network policy. A provider is an object
with `name`, `egress`, and `persistent()` (fonts for every document) and/or
`forDocument(text)` (fonts for one document, as `{ fonts, failed? }` so a partial failure
keeps what loaded), so you can write your own.

### Other scripts

June ships an offline font for Traditional Chinese only. Any other script works with a font you
choose, and the missing glyphs check tells you when one is missing:

```ts
import { googleFontSubsets, localFonts, typstWasmRenderer } from "@junejs/pdf-typst-wasm";

// A file you ship or download yourself: bytes, a URL fetched once, or a loader.
typstWasmRenderer({ fonts: [localFonts(["https://fonts.example.com/NotoSansThai-Regular.ttf"])] });

// Or per-document subsets from Google Fonts, which sends each document's characters there.
typstWasmRenderer({ fonts: [googleFontSubsets({ families: [{ family: "Noto Sans Thai" }] })] });
```

To check a file you fetch at runtime, pin it the way June pins its own: give `loadVerified` a
ref with its size and SHA-256, and it rejects any other bytes.

```ts
import { loadVerified, localFonts, type AssetRef } from "@junejs/pdf-typst-wasm";

// The file's byte size and hex SHA-256, recorded when you chose it.
const thai: AssetRef = { name: "NotoSansThai-Regular.ttf", size: THAI_SIZE, sha256: THAI_SHA256, urls: [THAI_URL] };
localFonts([() => loadVerified(thai, (ref) => fetch(ref.urls[0]!).then((r) => r.arrayBuffer()))]);
```

### Keeping the engine and fonts out of a single binary

`bun build --compile` embeds the engine (29 MiB) and `notoSansTC()`'s files (~11 MiB) as soon
as the app imports them, whether or not it ever renders a PDF. When PDF output is optional,
import the `unbundled` entries instead. They reference no files: you pass `load`, which is
called on the first render with each file's ref (`{ name, size, sha256, urls }`), and the
bytes are checked against the ref before they are used.

`assetCache` from `@junejs/server/assets` is a ready `load`: it keeps the files in a directory
you own, and downloads each one the first time.

```ts
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc/unbundled";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm/unbundled";
import { assetCache } from "@junejs/server/assets";

const load = assetCache({ dir: "/data/june-assets" });
const renderer = typstWasmRenderer({ load, fonts: [notoSansTC({ load })] });
```

- A file is used only when its size and SHA-256 match the ref, whether it came from disk or
  the network. A stale or corrupt copy is replaced, and a download stops at the expected size.
- Files land by rename from a temp file, so a crash never leaves a half-written one. Each
  file is downloaded once per cache, however many renders ask: create one `load` and pass it
  everywhere.
- `ref.urls` point at the release's own files: the engine on jsDelivr and unpkg, the fonts at
  their upstream tag. To fetch from a mirror you run, pass `urls: (ref) => [...]`. Since the
  sha256 is what is trusted, any copy that matches will do.
- **No network at all:** copy the files into the directory (`/data/june-assets/typst.wasm`,
  `/data/june-assets/NotoSansTC-Regular.otf`, …) and pass `offline: true`. A missing file then
  fails with its name, hash and where to get it.
- `load.egress(refs)` lists the hosts a call would still contact, `[]` once everything is
  cached, for a setup check. Until you say otherwise, `renderer.egress` lists the files' hosts
  with `sends: "nothing"`; pass `engineEgress: []` and `egress: []` when the files are
  pre-seeded and never fetched.

Measured on Bun 1.4.2, macOS arm64:

| `bun build --compile` | size |
| --- | --- |
| the Bun runtime alone | 59.3 MiB |
| default entries | 99.8 MiB |
| unbundled entries with `assetCache` | 59.4 MiB |

On first use the 40 MiB arrive once; after that the app renders offline. Any other `load` works
too: `` (ref) => readFile(`/opt/app/${ref.name}`) `` for files shipped beside the binary.
