# June

The agent-native React framework. One `load()` answers humans (HTML/RSC), data
clients (`.json`), and agents (`.agent`, `/mcp`, `.md`) without the surfaces
drifting. Server-reactive live RSC where **dev HMR is the production live path**,
on an owned Rust + V8 runtime.

## Layout

```txt
packages/
  @junejs/core/        The framework. Phase 1: the PURE, host-free contract layer
                   (route · config · document · agent · discovery · mcp · cache).
  create-june/     Scaffolder — `npm create june my-app`.
apps/
  june.build/      The framework site, dogfooded on June.
runtime/           Native runtime — a SEPARATE Cargo workspace (Phase 4).
bench/             Named-run registry (results.json); the site renders from it.
examples/          Fixtures (golden dev/built parity contract).
docs/              Architecture + the rebuild plan.
```

## The contract layer (Phase 1, here today)

`packages/@junejs/core` is pure: **zero `node:*` / `Bun.*`**, enforced by a CI guard
(`test/purity.test.ts`). Host concerns — the fs config loader, the content
pipeline, the dev server, build/deploy, the data layer — layer on top in later
phases and never reach into this package.

```ts
import { route, manifest } from "@junejs/core";
import { defineAction } from "@junejs/core/agent";

const createUser = defineAction({
  id: "createUser",
  description: "Create a user",
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  run: async ({ name }) => ({ id: crypto.randomUUID(), name }),
});

export default route({
  async load() { return { users: await listUsers() }; },
  view: ({ users }) => <UsersPage users={users} />,   // HTML / RSC Flight
  json: ({ users }) => ({ users }),                    // data API
  agent: ({ users }) =>                                // agent capability manifest
    manifest.resource("users", users).actions([createUser]),
});
```

`defineAction` is one definition surfaced five ways: the UI action, the `.agent`
manifest, the `/mcp` tool, the `/.well-known/api-catalog` entry, and the `Link`
header.

## Develop

```sh
bun install
bun test          # contract-layer suite (incl. the purity + resolution guards)
bun run typecheck # tsc --noEmit, strict
```

CI runs both on every push from commit #1.
