---
title: "59ms: anatomy of a dev cold start"
date: 2026-06-10
description: Where every millisecond of `june dev` goes, and the three cuts that took 244ms to 59ms.
tags: [performance, runtime]
---

*(The native Rust runtime is an experimental track — v0.1's `june dev` is the
Bun/Node host. These numbers are why the track exists.)*

We benchmarked our Rust dev runtime's cold start — process spawn to first HTML
byte — and then took it apart. Three cuts, all measured (medians, reproducible
scripts in the repo):

| cut | before | after |
| --- | --- | --- |
| listen-early (dev scripts off the critical path) | ~100ms blocking | 3ms to listening |
| V8 startup snapshot (Web globals baked into the heap) | 24.4ms | 5µs |
| React vendors in the snapshot's module map | 98ms | 18ms |

End to end: **244ms → 59ms** on a hello-world page, with the remaining budget
split between process spawn (~10ms) and first-render JIT (~30ms) — the latter
is V8 physics for unbundled dev, and the bundled production path has already
measured **22ms**.

The honest caveats: one dev machine, medians not marketing minimums, and
`next dev`/Vite comparisons are class-level, not same-app shootouts yet.
Benchmark rigor is its own roadmap item.

One number we did not expect: rebuilding a worker isolate after a file edit
dropped from 137ms to **16ms**, which is what makes push-based HMR (the server
re-renders and pushes the diff over the live channel) feel instant.
