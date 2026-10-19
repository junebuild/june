# @junejs/pdf-font-noto-sans-jp

## 0.2.2

### Patch Changes

- Updated dependencies []:
  - @junejs/pdf-typst-wasm@0.2.2

## 0.2.1

### Patch Changes

- [#393](https://github.com/junebuild/june/pull/393) [`7ba4eca`](https://github.com/junebuild/june/commit/7ba4eca545f0365c5e5d2c48414193e9db412b24) Thanks [@linyiru](https://github.com/linyiru)! - New packages: offline fonts for Simplified Chinese, Japanese and Korean, the same shape as `@junejs/pdf-font-noto-sans-tc` ([#381](https://github.com/junebuild/june/issues/381)).

  ```ts
  import { notoSansJP } from "@junejs/pdf-font-noto-sans-jp";
  typstWasmRenderer({ fonts: [notoSansJP()] }); // renderer.egress: []
  ```

  Each package ships Noto Sans CJK's regional subset (Sans2.004, SIL OFL) in regular and bold. Coverage was measured with fontTools, counting Typst's built-in fonts too:

  | package        | size   | coverage                                                           |
  | -------------- | ------ | ------------------------------------------------------------------ |
  | `notoSansSC()` | 16 MiB | every GBK character                                                |
  | `notoSansJP()` | 9 MiB  | every JIS X 0213 character                                         |
  | `notoSansKR()` | 9 MiB  | every KS X 1001 character except three hanja; all Hangul syllables |

  - Each package has the same entries as TC: Node, Bun (embedded by `bun build --compile`), Workers (Data modules), and `/unbundled` for `assetCache`.
  - Pick the package for the document's language. When you load several, use `fontFamilies` to choose which one supplies Han characters.
  - On Workers, the engine plus any two packages fit the 64 MiB limit by file size, but all four don't.

- Updated dependencies [[`b9a3c06`](https://github.com/junebuild/june/commit/b9a3c06e0a58aed55479c12a00162e19eab23bd5)]:
  - @junejs/pdf-typst-wasm@0.2.1
