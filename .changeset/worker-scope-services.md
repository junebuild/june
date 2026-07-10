---
"@junejs/core": patch
"@junejs/server": patch
---

Worker-side app services: `currentServices()` now resolves in loaders, views, and
actions — the symmetry twin of the services a Durable Object already seeds for its tools.

`scope.services` (added for the DO) was only seeded at the DO turn entry, so
`currentServices()` returned `undefined` everywhere the Worker pipeline runs — a route
`load()`, a view, or a `defineAction` invoked by the UI/`/mcp`. That made the SAME tool
behave differently depending on who called it (the agent in the DO vs the UI through the
pipeline).

Now the app declares services once in `june.config.ts` and the host seeds them at every
isolate entry, from that isolate's env:
- `@junejs/core/config` — `ServicesConfig { make(env): unknown; module }` + `defineServices`
  helper + `JuneConfig.services`. `make(env)` builds the bag from the isolate's env (typed
  `any` so the app writes `(env: MyEnv) => …` without a cast); `module` names the file whose
  `services` export IS `make`, so `june build` can import it into the worker (env only exists
  inside an invocation). Same pattern as `dataLayer`.
- `@junejs/server` — the pipeline seeds `runInScope({ resources, services })`; dev (`createApp`)
  builds the bag from `process.env`; the generated worker binds it from the worker env,
  memoized per isolate; the build imports the app's factory module into the entry (an
  app-relative path is rebased to the entry dir like a route import; a bare specifier is used
  as-is). Re-exports `defineServices`.

Additive: no `services` declared → `currentServices()` stays `undefined`, byte-identical
output. The app can single-source the DO too — `services: config.services.make(this.env)` in
the DO shell.
