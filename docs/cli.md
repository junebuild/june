# The `june` CLI + `create-june` (v0.1)

> Decided 2026-06-11. Two separate things: `create-june` (the scaffolder, run
> once) and `june` (the CLI, used repeatedly). The CLI is a LOCAL dep bin — no
> global install required — owned by the project the moment you scaffold it.

## Two tools, two roles

- **`create-june`** — the scaffolder. `npm create june my-app` is npm's convention
  for `npx create-june`: not installed, runs once, copies a template, installs deps.
- **`june`** — the dev-time CLI (`june dev | build | deploy | gen | info`). Lives
  as a LOCAL devDependency bin in the scaffolded project.

## Install model — you "own" the CLI the moment you scaffold

The standard ecosystem pattern: the template wires the CLI as a local dep + scripts,
so after scaffolding the project owns `june` locally — no global install, version
pinned per project, reproducible.

```sh
npm create june my-app        # runs create-june; scaffolds + installs
cd my-app && npm run dev       # `june` is already here, locally
```

`june` is then runnable three ways, all local: `npm run dev` (the script),
`npx june dev`, or `bun june dev`. A global install (`npm i -g @junejs/cli`) is
OFFERED as a convenience for `june` on PATH across projects, but is never required
(local is the reproducible default).

Runtime-agnostic: `npm create june` / `pnpm create june` / `bun create june` all
work; the bin runs under any package runner.

## Where the `june` bin lives (dependency direction)

`@junejs/core` stays PURE — no bin, no host import. So the CLI bin lives in a thin
**`@junejs/cli`** package that depends on `@junejs/server` (where dev/build/deploy
already are). The scaffolded project's manifest:

```jsonc
{
  "dependencies":    { "@junejs/core": "^0.1" },     // authoring API (route, agent, …)
  "devDependencies": { "@junejs/cli": "^0.1" },  // provides the `june` command
  "scripts": {
    "dev":    "june dev",
    "build":  "june build",
    "deploy": "june deploy",
    "gen":    "june gen"
  }
}
```

Dependency direction stays inward: `@junejs/cli` → `@junejs/server` → `@junejs/core`.
@junejs/core never learns the CLI exists.

## Verbs (v0.1)

| Verb | Does | Backed by |
| --- | --- | --- |
| `june dev [dir]` | Dev server (Bun/Node host). `--port`, `--host`. (`--native` experimental later) | `startDevServer` |
| `june build [dir]` | Freeze → workerd bundle. `--out` | `juneBuild` |
| `june deploy [dir]` | Build + wrangler. `--dry-run` | `juneDeploy` |
| `june gen [dir]` | Freeze content + schema (incl. Better Auth tables) + derived types; `--check` for CI drift | `generateContent` (+ schema/types as Juno migrations land) |
| `june info [dir]` | Introspect: routes × projections + the AGENT surface (llms.txt preview, MCP tools) | new (cheap) |

`june info` is a deliberate v0.1 verb: one command shows "what an agent sees",
reinforcing the agent-native story at low cost.

Deferred to v0.2 (don't fatten the CLI early): `june add <integration>` (one-shot
add Better Auth / a resource), `june db migrate` (once migrations land).

## Evolution: JS bin → native single binary

- **v0.1**: `june` is a JS bin running on the Bun/Node host (the supported path).
- **v0.2+**: because June owns a native Rust runtime, `june` can become a single
  native binary (like bun/deno/esbuild) — `npm create june` downloads the
  platform binary, or `curl | sh`, and `june dev` IS the native runtime. The
  user's `june dev` muscle memory never changes; only what's underneath does.

The install story itself is a differentiator: most framework CLIs are "node runs
a bundle of JS"; June's endgame is "one native binary, Node optional".

## Design rules

1. @junejs/core has no bin and no host dependency (purity invariant).
2. The CLI is a local dep bin; global install is optional, never required.
3. One template, runtime-agnostic (npm / pnpm / bun).
4. Keep the verb set tight; resist adding verbs until a real need appears.
