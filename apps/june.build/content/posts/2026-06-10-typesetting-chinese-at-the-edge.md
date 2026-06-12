---
title: 在邊緣排版中文:og:image 與字型子集化
date: 2026-06-10
lang: zh-Hant
description: 這篇文章的社群分享卡是在 Cloudflare Workers 上即時排版的——含這個中文標題。
tags: [og-image, fonts, edge]
---

這張文章的 og:image 不是預先生成的圖檔,而是一條會回傳 PNG 的路由:
satori 在 V8 isolate 裡排版 JSX、resvg(Rust 編成 WASM)光柵化,全程沒有瀏覽器。

中文是真正的考驗:完整的 Noto Sans TC 有好幾 MB,塞進 worker 不現實。
解法是 Google Fonts 的 `text=` 參數——**只下載這個標題用到的字形**,
子集只有幾十 KB,再用 workerd 的 Cache API 快取一週。

```
/og/<slug>.png → 偵測到 CJK → fetch 字型子集(text=標題)→ satori → resvg → PNG
```

另一條常見路徑是 build 時自托管字型(我們的資產管線也會做),
但 build 時無法預知動態標題的字形集合——runtime 子集化正是 og:image 場景的正解。
