# @june-examples/juno-crud

The smallest June app that opts into **Juno** (Tier 3). It declares a `db`
resource and `dataLayer: junoDataLayer()` in `june.config.ts`, then a route loader
uses the ambient canonical `db` (seed) and Juno's ambient `table()` (read) — no
handle to thread, `ctx` stays identity-only.

```bash
bun validate.ts   # end-to-end smoke: drives createApp().fetch() and checks the render
```

What it proves end-to-end (also covered by unit tests in @junejs/juno):
- `dataLayer: junoDataLayer()` → the host calls install() at boot → the canonical
  `db` auto-tags raw queries.
- ambient `db` and `table()` resolve the per-request scoped handle through the real
  pipeline (runInScope).
- `june build` emits `installDataLayer()` into the generated worker (prod parity).
