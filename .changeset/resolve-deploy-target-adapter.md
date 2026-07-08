---
"@junejs/server": patch
---

Resolve `deploy.target` to the built-in adapter at BUILD time (not just "static")

The build only special-cased `deploy.target === "static"` (→ `staticSite()`); every other
target — including `"vercel"` and `"deno"` — silently fell back to `workers()`. So a purely
DECLARATIVE config that can't express a `vercel()` call (e.g. `kura.toml`'s `[deploy] target =
"vercel"`) was packaged as a Cloudflare Workers bundle instead of a Vercel one. (`deploy.ts`
already resolved all four targets by name for the deploy VERB, so build and deploy disagreed.)

The adapter resolution is now `resolveDeployAdapter(deploy)` (exported): an explicit `adapter`
instance still wins, otherwise the `target` name selects the matching built-in —
`static`/`vercel`/`deno`/`workers` — defaulting to `workers()`. This puts build in lockstep with
`deploy.ts`, so `kura.toml` (or any string-only config) can target Vercel/Deno without importing
the adapter factory. `vercel()`/`deno()` use their default opts (runtime/regions, org/app aren't
carried on `JuneConfig.deploy` yet). Passing an `adapter` instance is unchanged.
