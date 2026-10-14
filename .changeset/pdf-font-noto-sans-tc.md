---
"@junejs/pdf-font-noto-sans-tc": minor
---

New package: Noto Sans TC as an offline font provider for `@junejs/pdf-typst-wasm`, so Traditional Chinese PDFs render with no network call (#368, #371).

```ts
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";

typstWasmRenderer({ fonts: [notoSansTC()] }); // renderer.egress: []
```

- Ships Noto Sans CJK's Taiwan subset (Sans2.004, SIL Open Font License) in regular and bold, ~11 MB. That covers 17,755 Han characters, including every Big5 one. A rarer character still fails the render as a missing glyph. `notoSansTC({ weights: [400] })` reads and registers only the regular weight, which halves the font memory. A Worker upload or a compiled binary still carries both files.
- Works on Node, Bun, Deno and Cloudflare Workers:
  - **Bun**: `bun build --compile` embeds the files.
  - **Workers**: they upload with the Worker as Data modules, about 40 of the 64 MiB limit together with the engine. Add `"rules": [{ "type": "Data", "globs": ["**/*.otf"] }]` to `wrangler.jsonc`.
