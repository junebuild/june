---
"@junejs/server": patch
---

fix(build): seed the config's app/_content imports so external-only content.sources bootstraps

A docs-as-code app keeps ALL content in external `content.sources` (e.g. the repo's own
`../docs`) with NO local `content/`. On a FRESH build the generated config imports
`app/_content.ts` (`import { DOCS } from "./app/_content"`), which the first freeze creates —
so `generateContent`'s bootstrap runs its two-pass: default scan → re-probe the config →
regenerate with the real sources. But with no local `content/`, Pass 1's default scan finds
zero collections and writes nothing, so the re-probe's config load STILL fails on the missing
`DOCS` export → the sources are dropped → `kura index: app/_content.ts not found` and the build
fails. (It only appeared to work locally when a stale `app/_content.ts` lingered from a prior
build; a clean CI/Vercel build has none.)

The bootstrap now seeds `app/_content.ts` with empty stubs for the EXACT names the config
imports from it (scanned from the config text), so the re-probe loads even before any content
exists. Apps with local `content/` are unaffected (Pass 1 already seeds them); the seed is
overwritten by the real freeze that follows a successful probe.
