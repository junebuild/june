---
"@junejs/og": patch
---

fix(og): lazy-load @vercel/og in the edge backend so the worker bundles without it

`edge.ts` (the `edge-light` condition, used by the vercel target) did a STATIC
`export { ImageResponse } from "@vercel/og"`. @vercel/og's entry statically imports
`./yoga.wasm?module`, which rolldown — June's worker bundler — can't bundle, so EVERY
worker carrying the OG route failed to build, even when OG is prerendered to static files
and @vercel/og is never called at runtime. Externalizing doesn't help: an ESM static
import is resolved at module load regardless of use (so consumers had to ship a throwing
@vercel/og stub just to get a clean bundle).

The edge backend now loads @vercel/og lazily via `new Function("return import(m)")` —
the same pattern node.ts already uses for satori/@resvg/resvg-js — so the bundler never
resolves it at build time. Edge/Node OG still renders at runtime (the consumer installs
@vercel/og; it's piped through unchanged), and a static-prerendered route, never invoked,
pulls nothing. Removes the need for the @vercel/og bundling stub on the vercel target.
