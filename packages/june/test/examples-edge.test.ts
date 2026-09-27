// The hand-written edge examples (every examples/* with its own Durable Object shell)
// are the code people copy, and nothing else imports them — so they drifted once: the
// two Slack examples kept a pre-streaming Model (Promise<ModelReply>, which the engine
// can't iterate) and the lazy apiKey SDK import that #171 moved every edge shell off,
// and no wrangler config carried the nodejs_compat flag `june build` emits. This file runs
// each example's real Durable Object class under bun:test — `cloudflare:workers` and
// `@anthropic-ai/sdk` are module mocks, ctx.storage is a fake SqlStorage over
// synchronous SQLite (the agent-durable.test.ts discipline) — and pins the configs.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SESSION_HEADER, sseTurnFinalText, type DurableStorage, type SqlStorage } from "../src/agent-durable";
import { openLocalSqliteSync } from "../src/sqlite-driver";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const EDGE_EXAMPLES = ["agent-edge", "slack-agent", "slack-feedback-agent"] as const;

// ── module mocks ────────────────────────────────────────────────────────────────
// workerd's DurableObject base only stores (ctx, env); the example's class-field
// initializer (`#agent = new AgentDurableObject(this.ctx, …)`) runs after it.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// A fake Anthropic SDK: records every construction and streams one canned text reply
// in the SDK's event shape (content_block_delta → finalMessage()).
const sdkConstructions: Array<{ apiKey?: string }> = [];
mock.module("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    constructor(opts: { apiKey?: string }) {
      sdkConstructions.push(opts);
    }
    messages = {
      stream: () => {
        const text = "hello from the injected client";
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "content_block_delta", delta: { type: "text_delta", text } };
          },
          finalMessage: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }),
        };
      },
    };
  },
}));

// ── fake ctx.storage ────────────────────────────────────────────────────────────
const open: Array<{ close(): void }> = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
  sdkConstructions.length = 0;
});

async function fakeStorage(): Promise<DurableStorage> {
  const db = await openLocalSqliteSync(":memory:");
  open.push(db);
  const sql: SqlStorage = {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings) as T[];
      return { toArray: () => rows, one: () => rows[0]! };
    },
  };
  return {
    sql,
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

type DoClass = new (ctx: { storage: DurableStorage }, env: Record<string, unknown>) => { fetch(req: Request): Promise<Response> };

async function doClassOf(example: (typeof EDGE_EXAMPLES)[number]): Promise<DoClass> {
  const mod = (await import(`${EXAMPLES}${example}/worker.ts`)) as Record<string, unknown>;
  const cls = Object.values(mod).find((v) => typeof v === "function" && /DO$/.test((v as { name: string }).name));
  if (!cls) throw new Error(`${example}/worker.ts exports no Durable Object class`);
  return cls as DoClass;
}

const turn = (userText: string) =>
  new Request("https://do/turn", {
    method: "POST",
    headers: { [SESSION_HEADER]: "s1" },
    body: JSON.stringify({ userText, turnId: "t1" }),
  });

// ── wrangler configs ────────────────────────────────────────────────────────────
// JSONC → JSON: these files use only full-line `//` comments (asserted, so a
// trailing comment can't slip past this naive strip and mis-parse).
function readJsonc(path: string): Record<string, unknown> {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l));
  for (const l of lines) expect(l).not.toMatch(/\s\/\/\s/);
  return JSON.parse(lines.join("\n"));
}

describe("edge examples: wrangler config", () => {
  // The list above is explicit (the tests name each example) — so pin it to what is on
  // disk: every example whose worker hand-writes an AgentDurableObject shell is covered.
  // A new edge example can't silently skip this suite, the way slack-feedback-agent once did.
  test("covers every example that hand-writes a Durable Object agent shell", () => {
    const shells = readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(`${EXAMPLES}${d.name}/worker.ts`))
      .filter((d) => /new AgentDurableObject\(/.test(readFileSync(`${EXAMPLES}${d.name}/worker.ts`, "utf8")))
      .map((d) => d.name)
      .sort();
    expect(shells).toEqual([...EDGE_EXAMPLES].sort());
  });

  for (const example of EDGE_EXAMPLES) {
    test(`${example}: binds the agent DO and carries nodejs_compat, like the \`june build\` output`, () => {
      const cfg = readJsonc(`${EXAMPLES}${example}/wrangler.jsonc`) as {
        compatibility_flags?: string[];
        durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
        migrations?: Array<{ new_sqlite_classes?: string[] }>;
      };
      // without the flag the DO has no request scope (node:async_hooks loads lazily):
      // ambient db/kv/blob throw, and currentServices() returns undefined
      expect(cfg.compatibility_flags).toContain("nodejs_compat");
      const binding = cfg.durable_objects?.bindings.find((b) => b.name === "AGENT");
      expect(binding).toBeDefined();
      expect(cfg.migrations?.[0]?.new_sqlite_classes).toContain(binding!.class_name);
    });
  }
});

// ── the Durable Object classes, end to end ─────────────────────────────────────
describe("edge examples: the Durable Object runs a turn", () => {
  test("slack-agent: with no key, the offline model streams a reply through the durable loop", async () => {
    const JuneSlackDO = await doClassOf("slack-agent");
    const agent = new JuneSlackDO({ storage: await fakeStorage() }, {});
    // a Promise<ModelReply> model can't be iterated — the turn would fail, not answer
    expect(await sseTurnFinalText(await agent.fetch(turn("hello")))).toBe(
      "(offline) You said: hello. Set SLACK_BOT_TOKEN + ANTHROPIC_API_KEY to let me read this thread.",
    );
    expect(sdkConstructions).toHaveLength(0); // offline: the SDK is never touched
  });

  test("slack-feedback-agent: with no key, the offline model streams a reply through the durable loop", async () => {
    const JuneSlackDO = await doClassOf("slack-feedback-agent");
    const agent = new JuneSlackDO({ storage: await fakeStorage() }, {});
    expect(await sseTurnFinalText(await agent.fetch(turn("hello")))).toBe("(offline) You said: hello");
    expect(sdkConstructions).toHaveLength(0);
  });

  test("agent-edge: with no key, the offline model drives a tool call to completion", async () => {
    const JuneAgentDO = await doClassOf("agent-edge");
    const agent = new JuneAgentDO({ storage: await fakeStorage() }, {});
    expect(await sseTurnFinalText(await agent.fetch(turn("order 3 widgets")))).toBe("Done — order placed.");
  });

  for (const example of EDGE_EXAMPLES) {
    test(`${example}: with a key, the SDK client is injected at construction, not lazily imported`, async () => {
      const DoClass = await doClassOf(example);
      const agent = new DoClass({ storage: await fakeStorage() }, { ANTHROPIC_API_KEY: "sk-test" });
      // Injection builds the client eagerly, in the DO constructor. The lazy path would
      // construct nothing until the first model call — and on workerd, not at all (#171).
      expect(sdkConstructions).toEqual([{ apiKey: "sk-test" }]);
      expect(await sseTurnFinalText(await agent.fetch(turn("hi")))).toBe("hello from the injected client");
      expect(sdkConstructions).toHaveLength(1); // the turn reused the injected client
    });
  }
});
