# @junejs/pdf

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @junejs/core@0.2.1

## 0.2.0

### Minor Changes

- [#374](https://github.com/junebuild/june/pull/374) [`3b94181`](https://github.com/junebuild/june/commit/3b94181c9af4e1054dddff7343f9267807ffa65e) Thanks [@linyiru](https://github.com/linyiru)! - `typstRenderer` and the `@junejs/pdf/typst` entry are removed, along with the optional `@myriaddreamin/typst.ts` peer dependencies. Use `@junejs/pdf-typst-wasm`. It typesets the same Markdown into the same layout, runs on Node, Bun, Deno and Cloudflare Workers, renders Latin text without any network call (typst.ts fetched even its Latin fonts from jsdelivr), and reports characters no font covers instead of leaving them blank.

  ```ts
  // before
  import { typstRenderer } from "@junejs/pdf/typst";
  pdfTools({ renderer: typstRenderer() });

  // after: bun add @junejs/pdf-typst-wasm (and remove @myriaddreamin/typst.ts, typst-ts-web-compiler)
  import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";
  pdfTools({ renderer: typstWasmRenderer() });
  ```

  Option mapping: `fonts: [bytes or url]` → `fonts: [localFonts([...])]`, and `fontFamilies` is unchanged. `fontAssets` has no equivalent: the Latin fonts are built in. For CJK, add a font with `localFonts` or `googleFontSubsets`. `fontAssets: ["cjk"]` was Simplified Chinese only.

- [#361](https://github.com/junebuild/june/pull/361) [`0fff693`](https://github.com/junebuild/june/commit/0fff693466caa15098c985fed9883626f3a4970a) Thanks [@linyiru](https://github.com/linyiru)! - New package: PDF output as an agent capability.

  ```ts
  // agent/tools/pdf.ts
  import { pdfTools } from "@junejs/pdf";
  import { typstRenderer } from "@junejs/pdf/typst";

  export default pdfTools({ renderer: typstRenderer() });
  ```

  - `pdfTools({ renderer })` adds a `render_pdf` tool: the model writes Markdown, the PDF is stored through `ctx.files` and attached to the conversation (in Slack, uploaded into the thread) Every input field is validated, and the model gets one error listing every problem.
  - The renderer is replaceable: anything that implements `PdfRenderer` (`render(doc) → Uint8Array`) works, such as a headless browser or a remote service.
  - `typstRenderer()` typesets on the Typst compiler built for WebAssembly. Install `@myriaddreamin/typst.ts` and `@myriaddreamin/typst-ts-web-compiler` to use it. It is verified on Bun and Node. On Cloudflare Workers the 28 MB module fits the 64 MiB size limit, but the renderer is not yet verified there: pass the compiled module as `wasm`, and use Workers Paid (one page takes more than the Free plan's 10 ms of CPU). It loads typst.ts's hosted Latin and Simplified Chinese fonts by default; for Traditional Chinese, Japanese or Korean, pass a font that covers it in `fonts`.
  - Copy `node_modules/@junejs/pdf/skills/pdf-report.md` into `agent/skills/` to teach the model how to write the document and when to call the tool.

- [#363](https://github.com/junebuild/june/pull/363) [`50783bd`](https://github.com/junebuild/june/commit/50783bdb306bc648852197a2319533ff1c05b477) Thanks [@linyiru](https://github.com/linyiru)! - `markdownToTypst` and `typstSource` are exported from `@junejs/pdf`. They are the Markdown → Typst conversion `typstRenderer` uses, so a renderer built on any Typst compiler (your own, or `@junejs/pdf-typst-wasm`) gets the same document from the same Markdown.

### Patch Changes

- Updated dependencies [[`fea4078`](https://github.com/junebuild/june/commit/fea407877de98adda39c2f277d45157ea9a8d6f0), [`862a969`](https://github.com/junebuild/june/commit/862a9693cc3ab00cfb5c08e6bc07542590b58349), [`7d1d670`](https://github.com/junebuild/june/commit/7d1d670734f3e4f478e3936670267616f253bc8f), [`cde48a2`](https://github.com/junebuild/june/commit/cde48a28d8a532b2d5d549d569894dff28caba39), [`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828), [`cc5905e`](https://github.com/junebuild/june/commit/cc5905ebd7b1498250ed1fc28223121072c059e7), [`0fff693`](https://github.com/junebuild/june/commit/0fff693466caa15098c985fed9883626f3a4970a), [`80576b2`](https://github.com/junebuild/june/commit/80576b274d7cb1be57875476b77b7b416d974d96), [`eac1daa`](https://github.com/junebuild/june/commit/eac1daa276c2f2f94ca1d98f2306a83a5a88563f), [`502d895`](https://github.com/junebuild/june/commit/502d89555c76cb11254fac2df09cfdb22b0384d3), [`cc70d23`](https://github.com/junebuild/june/commit/cc70d236c6824f4edc207c87ba094b299cdbeb15), [`7a8fff4`](https://github.com/junebuild/june/commit/7a8fff4ee78be4bd576824daca8d4b4acedbdc05), [`d062d48`](https://github.com/junebuild/june/commit/d062d48c1fe675fe0a18d1fad3eb143c1a270959), [`b46bc2c`](https://github.com/junebuild/june/commit/b46bc2c4a50cd3d213f9ed9da4bc079f1287f434), [`f2ed6ba`](https://github.com/junebuild/june/commit/f2ed6ba41bac8ac5dbab86a701385d6aca80b226), [`3c6e981`](https://github.com/junebuild/june/commit/3c6e98100d109f996f36cb876a3399e088da4d9a), [`4847104`](https://github.com/junebuild/june/commit/4847104007432e1916618529c3465cbd73c59982), [`8255355`](https://github.com/junebuild/june/commit/825535570f716a81445b490d9b93e98671527c70), [`7272fa5`](https://github.com/junebuild/june/commit/7272fa59a9a692753a5c349d1537ae0064aecd4b), [`7c2fb9d`](https://github.com/junebuild/june/commit/7c2fb9d02ae5a89f511676b72647e0e0423ce17c), [`410928a`](https://github.com/junebuild/june/commit/410928a389db7c2e07434ee03f02b94914202d0f), [`aaceb01`](https://github.com/junebuild/june/commit/aaceb01daec1fb8553e1f2b03627a8d54e9125f8), [`8f26396`](https://github.com/junebuild/june/commit/8f2639650be7a6c5baba8f2042d9173c4115d829), [`04909db`](https://github.com/junebuild/june/commit/04909dbf82dc45e3f003026d8ca8895e9adb8108), [`d323e45`](https://github.com/junebuild/june/commit/d323e458f5889b9179b137425af2ae8718b24d6e), [`0703648`](https://github.com/junebuild/june/commit/07036488b678e7cc6b17434d916908320a8fd7f8), [`19aa6e3`](https://github.com/junebuild/june/commit/19aa6e38a2a0e2cc42e2173ecdb4db94feb9490b), [`b1c31e4`](https://github.com/junebuild/june/commit/b1c31e4781a55013b266e709988331c256c90f11), [`ffdb05c`](https://github.com/junebuild/june/commit/ffdb05c83400632cde32abd59b86bb8186a48b6a), [`b20cc77`](https://github.com/junebuild/june/commit/b20cc7726736cfc48506e7a5d06ab7eddba9f466), [`ddb8a0c`](https://github.com/junebuild/june/commit/ddb8a0cb1b5b11483c920d3cad5f9d46a1f66a3a), [`fba01b9`](https://github.com/junebuild/june/commit/fba01b9060774db087594a7e825e8c4e2ff4a73f), [`09d9901`](https://github.com/junebuild/june/commit/09d99010df4865fed38cfa64c79efeccb200c0b0), [`044ff2f`](https://github.com/junebuild/june/commit/044ff2fcec8d507221d7a7d53f37eb635d1f7750), [`a10a457`](https://github.com/junebuild/june/commit/a10a457b8dddebbe76a15a9961da28d264dfb76b), [`0ccd10a`](https://github.com/junebuild/june/commit/0ccd10a8b40422eb164cfd4ba5c9e9bd64ba07b1), [`6048baa`](https://github.com/junebuild/june/commit/6048baa65d27c0e705b38516af15579970300733), [`48de649`](https://github.com/junebuild/june/commit/48de649acc7d91afa803e8d4241130ec38d58b70), [`fa15d1d`](https://github.com/junebuild/june/commit/fa15d1d08a04764647963d6ff9f42c3a75a6d900), [`0e676ac`](https://github.com/junebuild/june/commit/0e676ac478e5aa016408c360a3e221c01ca502a8), [`345fbad`](https://github.com/junebuild/june/commit/345fbad23a6cc8d11b822cffc014fe0903b4961d), [`7736376`](https://github.com/junebuild/june/commit/77363765ea883c3f620fd5c0b713c5f871b822c3), [`18cc523`](https://github.com/junebuild/june/commit/18cc523dabecf56ef510e64ce0b94edf02ce9e02), [`e396979`](https://github.com/junebuild/june/commit/e3969795a2cfb2d085f3f32b575507d44b371262), [`403d543`](https://github.com/junebuild/june/commit/403d54328efa9a2813c1f78af271d851f74becbb), [`128d733`](https://github.com/junebuild/june/commit/128d733a21465910bbf97d7e918deee15e6e920a), [`68e7adc`](https://github.com/junebuild/june/commit/68e7adc9f5912907e042bacb61296eac19ef3a79), [`b418d53`](https://github.com/junebuild/june/commit/b418d537ded688ddcae1098b1ae39c821650f813), [`3ad841c`](https://github.com/junebuild/june/commit/3ad841ce43daa5a5fb6af79927e840e117a6c979), [`4018c25`](https://github.com/junebuild/june/commit/4018c2569f96dc267e15520e20063693289145b7), [`0a47816`](https://github.com/junebuild/june/commit/0a4781607d6434873bfee9cab9989507ba0271bc), [`6a915e4`](https://github.com/junebuild/june/commit/6a915e4f3e2c07b8b35b086e1033836dae6696b3), [`5703ce1`](https://github.com/junebuild/june/commit/5703ce16b7aa3662a70ca95a80139abb11bc4c19), [`acb081e`](https://github.com/junebuild/june/commit/acb081e3fabf48431dbf8b11afc9e027b9e41301), [`981aa5c`](https://github.com/junebuild/june/commit/981aa5c54aeaf557fcdd4efe63300a2f78aaa306), [`c54a6f0`](https://github.com/junebuild/june/commit/c54a6f08547413c9a020b673b7181ea9fb496b01), [`6e31981`](https://github.com/junebuild/june/commit/6e319810e5888875434656f282e57818ec895229), [`7aee078`](https://github.com/junebuild/june/commit/7aee0786f2a28f78e20afe1f56b7d3991514a3b3), [`932e46f`](https://github.com/junebuild/june/commit/932e46f9d54e67f88b386a33bebf4ed82e56ff08), [`8d0544f`](https://github.com/junebuild/june/commit/8d0544f8df00c8d5cb0231271300eced730d091a), [`f797398`](https://github.com/junebuild/june/commit/f7973988af18f25ce5e3c27637c526949512b44f), [`6f3e89f`](https://github.com/junebuild/june/commit/6f3e89facf76df91ea10c02fe2c46a822d4af86d), [`784388b`](https://github.com/junebuild/june/commit/784388b6b197e8dc23d8d0f7195581fc227a51af), [`771772f`](https://github.com/junebuild/june/commit/771772f4f790a4fc48d4782ac5a7bff9e99f9943), [`d1c9f23`](https://github.com/junebuild/june/commit/d1c9f235e887c0253a805c442e4b1a9bf5c3cdc5), [`370849c`](https://github.com/junebuild/june/commit/370849cfa22050a8653895d5949b085646706a35), [`a5b49ed`](https://github.com/junebuild/june/commit/a5b49eda506c1796145bd4e1834dcc3c2c837b23), [`7c2c820`](https://github.com/junebuild/june/commit/7c2c820689370a71c9f114e6aac520e4e3030bcf), [`8128c20`](https://github.com/junebuild/june/commit/8128c2059c8085851e4ee0793b4ca4ef4a1390cd), [`38abeae`](https://github.com/junebuild/june/commit/38abeae8ab444ac66e8cdbc279aa602f94858bef), [`b7d4e55`](https://github.com/junebuild/june/commit/b7d4e5529be316c61e32ff363046b2c57480dfdd), [`7a6c6e6`](https://github.com/junebuild/june/commit/7a6c6e6887986f027b2bde5e595e1de98b7442d5), [`2b9eefe`](https://github.com/junebuild/june/commit/2b9eefec6c84044385e511a9637b4b98d5b9df50), [`ea29ca5`](https://github.com/junebuild/june/commit/ea29ca50916d524e47ce63d261719ba0366ae007), [`db3c835`](https://github.com/junebuild/june/commit/db3c83556b730d9b2184e89cd025296c0e42ef55), [`3a21f13`](https://github.com/junebuild/june/commit/3a21f13c0f52be58b5bf087d22e685be47f1a1c5), [`b414b0d`](https://github.com/junebuild/june/commit/b414b0d2fdca032f7d6e4e6ea1a3d1eb4334a306), [`17988f3`](https://github.com/junebuild/june/commit/17988f3f6ae2349f0f6c9589b2f8ff68c2c380cd), [`2e4cc43`](https://github.com/junebuild/june/commit/2e4cc43cabe64bc569c9f6039ffc6f68765c328f), [`1ebd63b`](https://github.com/junebuild/june/commit/1ebd63b6ebe3b9b1c4a8722a52ae1f0daff644d2), [`595772c`](https://github.com/junebuild/june/commit/595772cc4e1075677f490796981cf737018687f2)]:
  - @junejs/core@0.2.0

## 0.1.0-dev.2

### Minor Changes

- [#374](https://github.com/junebuild/june/pull/374) [`3b94181`](https://github.com/junebuild/june/commit/3b94181c9af4e1054dddff7343f9267807ffa65e) Thanks [@linyiru](https://github.com/linyiru)! - `typstRenderer` and the `@junejs/pdf/typst` entry are removed, along with the optional `@myriaddreamin/typst.ts` peer dependencies. Use `@junejs/pdf-typst-wasm`. It typesets the same Markdown into the same layout, runs on Node, Bun, Deno and Cloudflare Workers, renders Latin text without any network call (typst.ts fetched even its Latin fonts from jsdelivr), and reports characters no font covers instead of leaving them blank.

  ```ts
  // before
  import { typstRenderer } from "@junejs/pdf/typst";
  pdfTools({ renderer: typstRenderer() });

  // after: bun add @junejs/pdf-typst-wasm (and remove @myriaddreamin/typst.ts, typst-ts-web-compiler)
  import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";
  pdfTools({ renderer: typstWasmRenderer() });
  ```

  Option mapping: `fonts: [bytes or url]` → `fonts: [localFonts([...])]`, and `fontFamilies` is unchanged. `fontAssets` has no equivalent: the Latin fonts are built in. For CJK, add a font with `localFonts` or `googleFontSubsets`. `fontAssets: ["cjk"]` was Simplified Chinese only.

## 0.1.0-dev.1

### Minor Changes

- [#363](https://github.com/junebuild/june/pull/363) [`50783bd`](https://github.com/junebuild/june/commit/50783bdb306bc648852197a2319533ff1c05b477) Thanks [@linyiru](https://github.com/linyiru)! - `markdownToTypst` and `typstSource` are exported from `@junejs/pdf`. They are the Markdown → Typst conversion `typstRenderer` uses, so a renderer built on any Typst compiler (your own, or `@junejs/pdf-typst-wasm`) gets the same document from the same Markdown.

## 0.1.0-dev.0

### Minor Changes

- [#361](https://github.com/junebuild/june/pull/361) [`0fff693`](https://github.com/junebuild/june/commit/0fff693466caa15098c985fed9883626f3a4970a) Thanks [@linyiru](https://github.com/linyiru)! - New package: PDF output as an agent capability.

  ```ts
  // agent/tools/pdf.ts
  import { pdfTools } from "@junejs/pdf";
  import { typstRenderer } from "@junejs/pdf/typst";

  export default pdfTools({ renderer: typstRenderer() });
  ```

  - `pdfTools({ renderer })` adds a `render_pdf` tool: the model writes Markdown, the PDF is stored through `ctx.files` and attached to the conversation (in Slack, uploaded into the thread) Every input field is validated, and the model gets one error listing every problem.
  - The renderer is replaceable: anything that implements `PdfRenderer` (`render(doc) → Uint8Array`) works, such as a headless browser or a remote service.
  - `typstRenderer()` typesets on the Typst compiler built for WebAssembly. Install `@myriaddreamin/typst.ts` and `@myriaddreamin/typst-ts-web-compiler` to use it. It is verified on Bun and Node. On Cloudflare Workers the 28 MB module fits the 64 MiB size limit, but the renderer is not yet verified there: pass the compiled module as `wasm`, and use Workers Paid (one page takes more than the Free plan's 10 ms of CPU). It loads typst.ts's hosted Latin and Simplified Chinese fonts by default; for Traditional Chinese, Japanese or Korean, pass a font that covers it in `fonts`.
  - Copy `node_modules/@junejs/pdf/skills/pdf-report.md` into `agent/skills/` to teach the model how to write the document and when to call the tool.

### Patch Changes

- Updated dependencies [[`0fff693`](https://github.com/junebuild/june/commit/0fff693466caa15098c985fed9883626f3a4970a)]:
  - @junejs/core@0.2.0-dev.66
