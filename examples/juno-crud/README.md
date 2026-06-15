# @june-examples/juno-crud

The smallest June app that opts into **Juno** (Tier 3). It declares a `db`
resource and `dataLayer: junoDataLayer()` in `june.config.ts`, keeps its schema in
`db/migrations/`, and a route loader uses the ambient canonical `db` (seed) and
Juno's ambient `table()` (read) — no handle to thread, `ctx` stays identity-only.

`table("users")` carries its row type with **no inline generic**: `db/schema.d.ts`
was generated from the migration by `june db types` (re-run after each migration).

```bash
bun validate.ts   # end-to-end smoke: migrates, drives createApp().fetch(), checks the render
june db types     # regenerate db/schema.d.ts from db/migrations/ (already committed)
```

What it proves end-to-end (also covered by unit tests in @junejs/juno):
- `dataLayer: junoDataLayer()` → the host calls install() at boot → the canonical
  `db` auto-tags raw queries.
- schema lives in `db/migrations/`; `june db types` introspects it into the typed
  `table()` surface (`db/schema.d.ts`) — types can't drift from the database.
- ambient `db` and `table()` resolve the per-request scoped handle through the real
  pipeline (runInScope).
- `june build` emits `installDataLayer()` into the generated worker (prod parity).
