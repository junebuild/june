---
"@junejs/core": patch
---

Workers consumers can bundle @junejs/core again — the redis store's lazy `import("bun")` no longer leaks into dist as a literal (#141).

The source already guarded the Bun-only redis path with a non-literal specifier, but tsdown/rolldown constant-folded `const s = "bun"; import(s)` back into a literal `import("bun")` in `dist/cache.js` — and cache.ts sits in @junejs/core's root import graph, so EVERY consumer whose own bundler resolves imports statically (wrangler/esbuild for Workers) failed with `Could not resolve "bun"` even though the redis path never executes there. The specifier now lives in data (a `Map` lookup no bundler evaluates), the packed dist is verified fold-free by `scripts/smoke-packed.sh` (a plain-const guard survived in one module and folded in another — the optimizer's inlining is heuristic, so the guard is now asserted, not assumed), and the original repro (`wrangler deploy --dry-run` on examples/agent-edge) bundles clean.
