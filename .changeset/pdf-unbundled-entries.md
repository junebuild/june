---
"@junejs/pdf-typst-wasm": patch
"@junejs/pdf-font-noto-sans-tc": patch
---

New `unbundled` entries keep the PDF engine and fonts out of a `bun build --compile` binary until it renders (#383). The default entries embed `typst.wasm` (29 MiB) and Noto Sans TC (~11 MiB) as soon as the app imports them. For an app where PDF output is optional, most installs carry 40 MiB they never load.

```ts
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc/unbundled";
import { typstWasmRenderer, type AssetRef } from "@junejs/pdf-typst-wasm/unbundled";

const load = (ref: AssetRef) => readFile(`/data/june-assets/${ref.name}`); // or download from ref.urls
const renderer = typstWasmRenderer({ load, fonts: [notoSansTC({ load })] });
```

- The entries reference no files. `load` is called on the first render with each file's ref: `{ name, size, sha256, urls }`.
- The package checks the bytes against the ref's size and SHA-256 before using them (`loadVerified`). A loader that just downloads is as safe as a careful one.
- The engine's ref is generated at build from the file being published. Its URLs are the release's own file on jsDelivr and unpkg. The fonts point at their upstream Noto tag.
- `renderer.egress` lists those hosts with `sends: "nothing"`. Pass `engineEgress: []` / `egress: []` when you pre-seed the files.
- Measured (Bun 1.4.2, macOS arm64): 59.4 MiB with the unbundled entries, against 59.3 MiB for the Bun runtime alone and 99.8 MiB with the default entries.
- The default entries are unchanged. `loadVerified` and `AssetRef` are also exported from `@junejs/pdf-typst-wasm`, to pin your own font files.
