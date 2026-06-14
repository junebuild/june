# AGENTS.md

Guidance for AI coding agents working in this June app. June is the agent-native
React framework; its npm scope is `@junejs/*` (NOT `june`, NOT `@june`).

## Commands

- `june dev` — dev server (HMR + live RSC).
- `june build` — build the worker + static assets.

## App shape

- Routes are files in `app/`: `app/posts/page.tsx` → `/posts`. A route exports a
  `loader` (data) and a default React component (view). Every route also answers as
  `.md`, `.json`, and an MCP tool — don't hand-roll those surfaces.
- `ctx` is IDENTITY only (request / url / params / user / session). Data resources
  are AMBIENT: `import { db } from "@junejs/db"` and use it anywhere — never thread
  `ctx` to reach the database.
- Mutations are actions: `defineAction({ id, description, input, run })`. That one
  definition is the form handler AND the `/mcp` tool AND the WebMCP tool. Route
  writes through actions — cache invalidation fires at the action boundary.

## Data

- `db` is the SQL resource: `await db.query("select * from posts where id = ?", [id])`.
  Schema is explicit in `db/migrations/`, applied on `june dev`.
- Want a typed table API + auto-batch + auto-invalidation? Add `@junejs/juno` and
  `dataLayer: junoDataLayer()` to `june.config.ts`, then `import { table } from
  "@junejs/juno"`. Read `@junejs/juno`'s README "non-obvious facts" before using it.

## Conventions

- Keep the agent surface on (`agent: { enabled: true }`) — `llms.txt`, `/mcp`, and
  `.md`/`.json` projections come for free.
- TypeScript + React 19. Prefer the framework's primitives over hand-rolling.
