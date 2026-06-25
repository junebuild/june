---
"@junejs/server": patch
---

Render content markdown with sparkdown-gfm (wasm) instead of marked

The content pipeline now renders `entry.html` via `@momiji-rs/sparkdown-gfm` — a WASI-free WebAssembly
CommonMark + GFM renderer — replacing `marked`. Benchmarked on real docs (Bun): ~75× faster on small
pages and ~580× faster on large pages (marked degrades super-linearly: a 27KB page took ~130ms; the
same page renders in ~0.22ms), with GFM (tables, strikethrough, task lists, autolinks) at no extra
cost. Output is CommonMark-strict: headings stay bare (`<h2>…`), code fences keep `language-*`, and a
bare `{…}` is literal text. The wasm initializes once per process; this module is build/dev-only, so it
never enters the worker bundle.
