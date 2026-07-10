---
---

ci: unbreak the `node-host` and `packed` smokes after the dual-export + prerelease rollout.

Repo tooling only — no published-package behavior changes (hence no version bump):

- `node-host` smoke resolved `@junejs/*` via the dual-export `default` condition
  → `dist/*.js`, which the from-source run never builds. Run it with
  `--conditions=source` so `@junejs/core/cache` etc. resolve to `src/*.ts`.
- `scripts/smoke-packed.sh` derived each package name from the tarball FILENAME by
  stripping `-<version>`, which broke on prerelease versions
  (`junejs-core-0.1.0-dev.4.tgz` → `@junejs/core-0.1.0`). The override then missed
  and npm installed the STALE published package instead of this tree's tarball, so
  the packed E2E was silently testing published packages, not local. Read the name
  from the tarball's own `package.json` instead.
