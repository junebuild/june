---
title: "The agent/ directory"
nav: "The agent/ directory"
description: The file convention that defines an agent — agent.ts, instructions and per-surface variants, tools, skills, channels, connections — and defineAgent(), its programmatic form.
date: 2026-09-27
section: Agents
order: "16.1"
sources: [packages/june/src/agent-discover.ts, packages/june/src/agent-compile.ts, packages/core/src/agent-config.ts, packages/core/src/agent.ts, packages/core/src/agent-runtime.ts, packages/core/src/agent-models.ts, packages/june/src/agent-native.ts, packages/june/src/app.ts, packages/june/src/build.ts, examples/agent-edge]
---
## The convention

An agent is a directory. Where a file sits decides what it does:

```text
app/agent/
  agent.ts                 → default-exports the config { name, model?, description?, instructions?, surfaces? }
  instructions.md          → base system prompt
  instructions.slack.md    → variant for turns arriving via the "slack" source
  tools/
    create_order.ts        → default-exports a defineAction
    drive.ts               → …or an array of them (e.g. googleDriveTools())
    approve_refund.ts      → …or a raw Tool (for ctx.requestInput)
  skills/
    refunds.md             → a procedure loaded on demand via read_skill
  channels/
    slack.ts               → default-exports a Channel or an (env) => Channel factory
  connections/
    crm.ts                 → default-exports a Connection
```

In a June app the directory is `app/agent/`. The name comes from
`agent.runtime.dir` in `june.config.ts` and defaults to `"agent"`. A standalone
Worker keeps it at `<root>/agent/`. Files whose names start with `_` are
private and never scanned. That's how the generated `_agent.gen.ts` stays out
of its own tool list. Code must be `.ts` and prose must be `.md`.

Native dev discovers the directory with the filesystem and dynamic imports.
Workers have no filesystem, so `june gen` compiles the same directory into
`_agent.gen.ts`, with static imports and the markdown inlined. Both routes
assemble through the same core function, so the result can't differ.

## agent.ts

`agent.ts` default-exports a plain object:

```ts
// app/agent/agent.ts
export default {
  name: "ops",
  model: "claude-opus-4-8",
  description: "An ordering assistant that places orders.",
  surfaces: {
    slack: { mode: "append", denyTools: ["issue_refund"] },
  },
};
```

| field | type | meaning |
|---|---|---|
| `name` | `string` | The agent's name. If `agent.ts` is missing, the directory's basename is used. |
| `model` | `string?` | The model id handed to the Anthropic adapter, both in dev and in the generated Worker entry. If omitted, the adapter's own default applies (see Models below). |
| `description` | `string?` | Carried on the assembled definition. |
| `instructions` | `string?` | An inline system prompt. Used only when `instructions.md` is missing or empty. |
| `surfaces` | `Record<source, { mode?, denyTools? }>?` | Mechanics for each inbound source (see Surfaces below). |

## instructions.md and per-surface variants

`instructions.md` is the base system prompt. If the agent has skills, a
one-line index of them is appended (see skills/ below).

`instructions.<source>.md` is a variant that applies only to turns whose
inbound event came through that source. The source is the channel that produced
the event, such as `slack` or `crisp`. One agent can then behave differently on
Slack than over HTTP. The switch is keyed on the real inbound source, not on a
marker in the user's text.

How a variant combines with the base is set per source in `agent.ts`:

- `mode: "append"` is the default. The variant goes after the base
  instructions.
- `mode: "replace"` makes the variant the turn's *entire* system prompt, and the
  base is dropped. Use it when a surface really isn't the base agent's behavior.

The rules are strict:

- **Setting `mode` without a variant file throws** at assembly: `surfaces.<source>
  declares mode "…" but instructions.<source>.md does not exist`. A mode with
  nothing to compose is a wiring error.
- **`denyTools` without a variant file is fine.** It's policy with no prose.
- **A surface key that matches no mounted channel** logs a warning (`surface
  policy "<source>" matches no mounted channel … it will never fire`).
- **Filenames must be a single lowercase segment.** Only
  `instructions.<source>.md` with `<source>` matching `[a-z0-9_-]+` is parsed.
  Any other `instructions.*.md` logs `unrecognized instructions variant` and is
  ignored. The file doesn't silently do nothing.
- **Locale variants are not built yet.** `instructions.slack.zh-TW.md` hits the
  warning above. Locale variants are planned (junebuild/june#149).
- **`channels/<source>.md` is deprecated.** It's still honored, but it logs
  `deprecated: channels/<source>.md — move it to instructions.<source>.md`.
  Behavior prose belongs to the agent. Channels are pure transport. If the same
  source is defined both ways, assembly throws.

## tools/

Each `tools/*.ts` file default-exports one tool or an array of tools. Arrays are
flattened, so an integration can ship several capabilities from one file.

```ts
// app/agent/tools/lookup_order.ts
import { defineAction } from "@junejs/core/agent";
import { db } from "@junejs/db";

export default defineAction({
  id: "lookup_order",
  description: "Look up one of the caller's orders by id.",
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  requiresPrincipal: true,
  run: async ({ id }, ctx) => {
    return db.query("select * from orders where id = ? and user_id = ?", [id, ctx.user!.id]);
  },
});
```

A tool file is a normal `defineAction`, the same object your UI calls and `/mcp`
lists. When the agent runs it:

- **The action's `id` is the tool name, and `description` and `input` are its
  spec.** Two tools with the same name make assembly throw (`duplicate tool
  name`). This includes clashes with channel-provided tools.
- **The turn's identity becomes `ctx.user`.** The resolved principal (a
  verified identity from a channel, never the model's input) is passed as
  `ctx.user`. The same check you wrote for the UI covers the agent.
- **`requiresPrincipal: true` hides the tool on anonymous turns.** The model
  doesn't see it in its tool list and can't call it.
- **Sync or async decides the delivery guarantee.**

| `run` is | the engine treats it as | guarantee |
|---|---|---|
| a plain (sync) function | a local tool | **exactly-once for writes through `ctx.store.unwrap()`**: those, the checkpoint, and the transcript append commit in one transaction |
| an `async` function | a remote tool | **at-least-once**: it runs, then its result is checkpointed, so a crash in between re-runs it |

The transaction only covers the session store's own handle, which lives on the
raw tool context — a `defineAction` can't reach it. A sync tool that writes to
another database, or causes any other side effect, gets no rollback: treat that
effect as at-least-once and make it idempotent. See
[Durable turns](/docs/agents-durable-turns) for an exactly-once write.

The engine checks for an `async` function specifically
(`run.constructor.name === "AsyncFunction"`). A plain function that returns a
promise is still classified as sync.

### Raw tools and `ctx.requestInput`

A tool file may also default-export a raw `Tool` (`{ spec, run }`). A
`defineAction`'s `run` only gets `{ user }`. A raw tool's `run` gets the full
`ToolContext`, which includes `event`, `principal`, `initiator`, `store`, and
`requestInput`. It's the only way to park a turn for human input:

```ts
// app/agent/tools/approve_refund.ts
import type { Tool } from "@junejs/core/agent-runtime";

const approveRefund: Tool = {
  spec: {
    name: "approve_refund",
    description: "Ask a human to approve a refund before issuing it.",
    input: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  requiresPrincipal: true,
  run: async (input: { orderId: string }, ctx) => {
    const answer = await ctx.requestInput({ id: "approve", prompt: `Refund order ${input.orderId}?` });
    return { orderId: input.orderId, approved: answer };
  },
};

export default approveRefund;
```

`requestInput` works only from an `async` tool. A sync tool commits in one
transaction and can't park, so calling it there throws. A raw tool isn't a
`defineAction`, so it isn't in the action registry: it doesn't appear on
`/mcp` or as a server action. Parking and resuming are covered in
[Durable turns](/docs/agents-durable-turns).

## skills/

Each `skills/*.md` file is a procedure the model loads only when it needs it.
Frontmatter is optional:

```md
---
name: refunds
description: How to process a refund end to end
when-to-use: the customer asks for their money back
---
1. Look up the order with lookup_order.
2. …
```

Without frontmatter, the skill's name is the filename and its description is the
first non-empty line, minus a leading `# `. If any skills exist:

- A `read_skill` tool is added automatically. It takes `{ name }` and returns
  the skill's body.
- The system prompt gets an index section, `## Available skills (call
  read_skill to load one)`, with one line per skill: `- name: description — when
  to use: …`.

## channels/ and connections/

- **`channels/*.ts`** default-exports a `Channel` or an `(env) => Channel`
  factory. Use the factory on Workers, where secrets only exist in `env`. The
  channel's key is the file's basename. A channel's own tools (for example,
  `slackChannel`'s `slack_read_thread`) are merged into the agent's tools. See
  [Channels](/docs/agents-channels).

  ```ts
  // app/agent/channels/crisp.ts
  import { crispChannel } from "@junejs/core/channels";

  export default (env: { CRISP_SIGNATURE_SECRET?: string; CRISP_IDENTIFIER?: string; CRISP_KEY?: string }) =>
    crispChannel({
      signingSecret: env.CRISP_SIGNATURE_SECRET ?? "",
      identifier: env.CRISP_IDENTIFIER ?? "",
      key: env.CRISP_KEY ?? "",
    });
  ```

- **`connections/*.ts`** default-exports a `Connection`, built with
  `defineMcpConnection`, `defineOpenapiConnection`, or
  `defineProviderConnection` from `@junejs/core/connections`. They're wired
  where the agent runs, and their remote tools join the tool list. See
  [Connections](/docs/agents-connections).

## Surfaces

`surfaces` in `agent.ts` holds the mechanical policy for each source, next to
the prose in the `instructions.<source>.md` variants:

```ts
surfaces: {
  slack: { mode: "replace", denyTools: ["issue_refund", "delete_account"] },
}
```

`denyTools` is enforced, not suggested. On a turn from that source, the listed
tools are **dropped from the model's tool list and can't be dispatched**. A
call to one fails as an unknown tool. No prompt injection can talk the model
into a tool it was never given. The deny list is stored with the turn's
checkpoint, so it survives a crash-replay or a resume.

## Models

The model behind an agent is a plain function over the `Model` interface from
`@junejs/core/agent-runtime`. It takes the messages and tool specs and streams
back deltas. June ships one adapter, `anthropic()` from
`@junejs/core/agent-models`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@junejs/core/agent-models";

// native: the SDK is imported lazily; ANTHROPIC_API_KEY comes from process.env
const model = anthropic({ model: "claude-opus-4-8", maxTokens: 16000 });

// bundled / edge: inject the client so the bundler sees the SDK
const edgeModel = anthropic({ client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) });
```

| option | default | notes |
|---|---|---|
| `model` | `"claude-opus-4-8"` | The value the adapter uses when `agent.ts` has no `model` |
| `apiKey` | — | Only for the lazy-import path. Leave it out on native, where `ANTHROPIC_API_KEY` is read. **Don't use it on the edge**: `apiKey` alone still takes the lazy import a bundler can't see. Inject `client` built with the edge secret instead |
| `system` | — | A construction-time system prompt. The runtime's per-turn system prompt (the agent's instructions) wins |
| `maxTokens` | `16000` | |
| `thinking` | `false` | `true` sends adaptive thinking. It's off by default because the transcript doesn't yet persist thinking blocks |
| `client` | — | An already-built SDK client. It skips the lazy `@anthropic-ai/sdk` import, and it's required in a bundled app (`bun build --compile`, a single-file Worker bundle), where the bundler can't see that import |

`@anthropic-ai/sdk` is an optional peer dependency (`>=0.60.0`). The dev server
and the generated Workers entry both build `anthropic({ model: <agent.ts model> })`
for you. To use another provider or a scripted test model, mount the agent
programmatically and pass any function that fits `Model`. For example,
`examples/agent-edge` falls back to a deterministic scripted model when no API
key is set.

## defineAgent(): the programmatic form

The directory is sugar over `defineAgent()` from `@junejs/core/agent-config`,
which takes the same pieces as values:

```ts
import { defineAgent } from "@junejs/core/agent-config";
import { httpChannel } from "@junejs/core/channels";
import { createOrder } from "./actions";

export const agent = defineAgent({
  name: "ops",
  model: "claude-opus-4-8",
  instructions: "You are an ordering assistant.",
  tools: [createOrder],                 // defineActions, raw Tools, or arrays of either
  skills: [],                           // Skill objects ({ name, description, whenToUse?, body })
  channels: [httpChannel()],
  surfaces: { slack: { denyTools: ["create_order"] } },
  surfaceInstructions: {},              // what instructions.<source>.md would supply
});
```

It does the same work as directory assembly. It adapts actions into tools,
merges channel tools, adds `read_skill` when skills exist, rejects duplicate
tool names, and derives the per-surface policies. To run the result
in-process, pair it with a model on a runtime from `@junejs/server/agent-native`:

```ts
import { anthropic } from "@junejs/core/agent-models";
import { createNativeRuntime, mountAgent, toAgentDef } from "@junejs/server/agent-native";

const rt = await createNativeRuntime({ [agent.name]: toAgentDef(agent, anthropic({ model: agent.model })) }, "./agent.db");
const { surface } = mountAgent(agent, rt); // POST /message + the agent's channels
```

Build the runtime entry with `toAgentDef(agent, model)`. Then the engine and the
channels share one definition. If they diverge, `mountAgent` logs a warning.

## Why it matters

The directory *is* the manifest: adding a tool means adding a file. Tools are
the actions you already have, so the agent is checked by the same gate as your
UI. Per-surface behavior is split into prose (a markdown variant) and
enforcement (`denyTools`), so what the model is told and what it's allowed to do
can't drift apart.
