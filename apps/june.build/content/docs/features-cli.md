---
title: "The june CLI"
nav: "CLI"
description: Five verbs — dev, build, deploy, gen, info — installed locally by the scaffold, version-pinned per project, with --dry-run as the CI contract.
date: 2026-06-12
section: Features
order: "32"
---
## The feature

```bash
npm create june my-app    # scaffold (package: create-june) — wires the CLI locally
cd my-app && npm run dev
```

The scaffold installs `june` as a local devDependency: no global install,
version pinned per project, reproducible for every collaborator — human or
agent. Then the whole loop is five verbs:

```bash
june dev          # dev server (Bun/Node host), zero config
june build        # Workers bundle: dist/worker.js + prerendered assets
june deploy       # build → wrangler upload → URL (--dry-run validates only)
june gen          # freeze content/**/*.md → app/_content.ts
june info         # show routes + the agent surface
```

## The contract verbs

- `june deploy --dry-run` runs the full build and config resolution without
  uploading — it's also the CI test, so "deployable" is continuously asserted.
- `june info` is the app's oracle: what routes exist, what tools an agent
  would see at `/mcp`, what discovery endpoints are live. If `info` shows it,
  it's served; if it doesn't, it isn't.

## Canonical names

Scaffold with `create-june`; the packages are `@junejs/core` and
`@junejs/cli`. NOT `june` (an unrelated npm package), not `junejs`, not
`@june/*` (not our scope). The same warning ships in every app's `/llms.txt`
so agents installing dependencies get it from the source.

## Why it matters

A CLI you "own" the moment you scaffold — local, pinned, reproducible — is
the difference between onboarding that's one command and onboarding that's a
wiki page. The dry-run contract keeps deployability a tested property instead
of a Friday surprise.
