---
title: "DX: a loop with no assembly"
nav: "DX"
description: Zero-config dev, dev/built parity by construction, an oracle for every artifact — and push-based HMR on the experimental runtime track.
date: 2026-06-12
section: Features
order: "7"
---
## Zero-config dev

`june dev` runs with nothing installed around it: declared resources get
local defaults — `db` is an embedded SQLite file, `blob` a local directory,
`kv` in-memory. No Docker, no service to start. Declare the deploy adapter
(`d1("DB")`, `r2("UPLOADS")`) and the SAME code runs on Workers.

## Parity by construction

Dev and the built worker share one render core — projections, discovery,
document, layout wrapping are the same code. `june build` freezes what dev
discovers at request time (routes, config, content, prerender) and the golden
parity tests assert byte-level agreement. "Works in dev, breaks deployed" is
treated as a framework bug, not your bug.

## An oracle for every artifact

```bash
june info        # routes + the agent surface (tools, discovery endpoints)
june gen         # freeze content — and see exactly what the manifest holds
june deploy --dry-run   # the full build + config resolution, no upload — CI runs this
```

Conventions a coding agent can't misread are conventions a human can't
misread either: file-system routing, plain SQL migrations, one config file
that exists to turn things off.

## HMR (experimental runtime track)

v0.1's `june dev` host is Bun/Node. The owned Rust+V8 runtime — the
experimental track — does push-based HMR: on save, the server re-renders and
pushes the RSC diff over the live channel. Measured median **73ms** from save
to flight pushed, with isolate rebuild at **16ms** ([benchmarks](/benchmarks),
`scripts/bench-hmr.ts`). The push loop is the same machinery as production
live-RSC — dev speed and the live features are one investment.

## Why it matters

DX debt compounds: every adapter you hand-wire is something to misconfigure,
and now there are two kinds of authors (humans and agents) misconfiguring it.
The framework's job is to make the default loop need no assembly at all.
