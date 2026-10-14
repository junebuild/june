---
"@junejs/pdf-font-noto-sans-sc": patch
"@junejs/pdf-font-noto-sans-jp": patch
"@junejs/pdf-font-noto-sans-kr": patch
---

New packages: offline fonts for Simplified Chinese, Japanese and Korean, the same shape as `@junejs/pdf-font-noto-sans-tc` (#381).

```ts
import { notoSansJP } from "@junejs/pdf-font-noto-sans-jp";
typstWasmRenderer({ fonts: [notoSansJP()] }); // renderer.egress: []
```

Each package ships Noto Sans CJK's regional subset (Sans2.004, SIL OFL) in regular and bold. Coverage was measured with fontTools, counting Typst's built-in fonts too:

| package | size | coverage |
| --- | --- | --- |
| `notoSansSC()` | 16 MiB | every GBK character |
| `notoSansJP()` | 9 MiB | every JIS X 0213 character |
| `notoSansKR()` | 9 MiB | every KS X 1001 character except three hanja; all Hangul syllables |

- Each package has the same entries as TC: Node, Bun (embedded by `bun build --compile`), Workers (Data modules), and `/unbundled` for `assetCache`.
- Pick the package for the document's language. When you load several, use `fontFamilies` to choose which one supplies Han characters.
- On Workers, the engine plus any two packages fit the 64 MiB limit by file size, but all four don't.
