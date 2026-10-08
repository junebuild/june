# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Copilot, Cursor, and others) working in this repository.

June is a React framework where one route definition serves humans (streamed HTML) and agents
(`.md`, `.json`, MCP at `/mcp`), and an `agent/` directory turns an app into an agent. It is a
pre-1.0 preview (packages publish under the `dev` tag): APIs change between releases.

## Commands

Bun is the toolchain. Its version has one source, `packageManager` in the root `package.json`:
every workflow's `setup-bun` reads it, and so does `flake.nix`. Bump it with
`bun scripts/bump-bun.ts <version>`, which also rewrites the release hashes in `nix/bun.json`.
Node 24 is needed only for the Node-host and packed-tarball smokes.

`nix develop` (optional) gives that exact toolchain: the pinned Bun, Node 24 and jq, on
aarch64-darwin, x86_64-linux and aarch64-linux. Prefix any command below with
`nix develop -c` to run it there. `nix flake check` verifies the pinned Bun reports the
`packageManager` version.

For an isolated agent sandbox on Linux, the flake also builds an OCI image with the same
toolchain plus git, gh, ripgrep and the usual shell tools (`nix/sandbox-image.nix`). It runs as
the unprivileged user `agent` in `/workspace` and needs no Nix at run time:

```bash
docker run --rm -it ghcr.io/junebuild/june-sandbox:latest   # published from main, amd64 + arm64
nix build .#sandbox-image && ./result | docker load          # or build it: june-sandbox:latest
```

`scripts/dev-agent.sh <issue>` runs Claude Code on a GitHub issue in its own dev container: a
fresh clone, bypass permissions, inside a tmux session you can detach from. Credentials come in
by name from `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`; the header of the script has the rest.

Two words, two things: a **dev container** is where a coding agent works *on* June, with its
harness and credentials inside. A **Sandbox** is the framework primitive (#348) where an agent
built *with* June runs its shell commands, with the harness and secrets kept outside.

```bash
bun install
bun run ci                                   # typecheck + full test suite (what CI's `check` job runs)
bun run typecheck                            # tsc --noEmit over packages/*/src, packages/*/test, examples/basic
bun test packages/june/test/parity.test.ts   # one file
bun test parity                              # files whose path matches
bun test -t "contract layer purity"          # tests whose name matches
cd packages/june && bun run build            # tsdown → dist/ (only needed for publishing)

# The other CI jobs:
bash scripts/smoke-packed.sh                          # published tarballs as an npm user gets them
node --conditions=source --import tsx scripts/smoke-node.ts   # dev server on node:http, no Bun
bun scripts/smoke-workerd.ts                          # `june build` examples/basic, run it on workerd
bash scripts/smoke-sandbox-image.sh                   # all of the above inside the sandbox image (Linux, Nix, Docker)

cd apps/june.build && bun run gen            # regenerate app/_content.ts after editing content/
```

Live contract suites are skipped unless their env vars are set: `SLACK_LIVE_BOT_TOKEN` +
`SLACK_LIVE_CHANNEL` (`bun test slack-live`), `GITHUB_LIVE_APP_ID` / `GITHUB_LIVE_PRIVATE_KEY` /
`GITHUB_LIVE_REPO` (`bun test github-live`), `JUNO_LIVE_PG`, `JUNO_LIVE_MYSQL`. The default suite
stubs `fetch` and needs no network or credentials.

## Architecture

**Packages and the purity rule.** `packages/core` (`@junejs/core`) is the pure contract layer:
no `node:*`, no `bun`, no `Bun.*`, no literal host dynamic imports. `test/purity.test.ts`
enforces it, because the worker graph must load on workerd. Host code lives in `packages/june`
(published as `@junejs/server`; the directory name differs), where `node:*` imports are fine.
`cli` is the `june` command, `db` the request-scoped `db`/`kv`/`blob`, `juno` the default data
layer, `og` og:image rendering, `i18n` ICU messages, `create-june` the scaffolder plus the app
`template/`.

**No build step inside the repo.** Every package export has a `source`/`bun` condition pointing
at `src/*.ts`, and `tsconfig.base.json` sets `customConditions: ["source"]`, so tests and
examples run straight from source. `dist/` exists only for publishing; Node needs
`--conditions=source` to resolve the same way.

**One render core, two drivers.** `packages/june/src/pipeline.ts` is the single render funnel.
The dev server (`app.ts`) feeds it routes discovered from the filesystem per request; the built
worker (`worker.ts`) feeds it a manifest that `june build` froze at build time (`build.ts` with
`route-scan.ts`, `content-freeze.ts`, `config-freeze.ts`, `manifest.ts`). The two must stay
byte-equivalent. `test/parity.test.ts` asserts it against `examples/basic`, so dev-only or
worker-only behavior goes into the injected `RouteResolver`, never into a branch in the pipeline.
`smoke-workerd.ts` covers what parity cannot: the real workerd runtime and the ASSETS binding.

**Seams for runtimes and deploy targets.** `host.ts` is the interface to the JS runtime (port
binding, the Flight subprocess, an async-first `JuneDb`). `adapter.ts` packages the same
portable `createWorker(manifest)` bundle for Workers (default), Vercel, Deno, or a static
export; an adapter never re-bundles.

**Agent runtime.** `core/src/agent-runtime.ts` is the durable turn engine. It depends only on
the `SessionStore`, `EventSink` and `Model` seams, and replays a session from its `messages`
log with memoized step checkpoints. `june/src/agent-native.ts` implements those seams over local
SQLite (`bun:sqlite` or `node:sqlite`); `agent-durable.ts` implements them on a Cloudflare
Durable Object, one DO per session, using structural types instead of importing
`cloudflare:workers`. `core/src/agent.ts` holds the `defineAction` registry: one action is both
a server action and an MCP tool. `core/src/supervise.ts` is the operator supervision contract
(parked inputs, decisions) that the server's inbox API implements.

**MCP.** `core/src/mcp.ts` is a hand-rolled `Request → Response` handler, identical on every
host, and serves both protocol eras: 2026-07-28 first, 2025 as fallback.
`core/test/mcp-interop.test.ts` checks interop against the official SDK v2. It runs under
`bun test` but is excluded from `tsc`, because the SDK's dependencies export raw TS under the
`source` condition.

**Other trees.**
- `examples/` are test fixtures as much as demos (`examples/basic` is the parity fixture and is
  typechecked).
- `apps/june.build` is the docs site, built with June itself.
- `runtime/` is an experimental Rust + V8 runtime in its own Cargo workspace, outside CI.
- `poc/` holds spikes, not product code.
- `docs/` holds RFCs and design notes; read the relevant RFC before changing the agent, email,
  or TUI layers.

## Conventions

- Source files open with a header comment explaining *why* the module is shaped the way it is,
  often citing the PoC bug it prevents. Keep these accurate when changing the module.
- Commit subjects follow `type(scope): summary (#issue)`, e.g. `fix(server): …`, `docs(mcp): …`,
  `test(core): …`.
- A change to a published package ships with a changeset in `.changeset/*.md`. Changesets is in
  pre mode (tag `dev`). Write the changeset for app authors: what changed and, for a breaking
  change, how to migrate. Merging the "Version Packages" PR bumps versions; publishing happens
  separately, triggered by a tag (`publish.yml`).
- Docs pages in `apps/june.build/content/docs/*.md` list the code they describe in `sources:`
  frontmatter. On PRs that touch `packages/**`, the Kura Curator bot commits doc updates onto the
  PR branch without regenerating `app/_content.ts`. Run `git pull --rebase` before pushing,
  then `bun run gen` in `apps/june.build`; never force-push over the bot's commits.
