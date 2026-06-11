// THE FLAGSHIP: a Juno write auto-invalidates a Juno read's cache with ZERO
// manual revalidate(). This is the agent-native differentiator — it works
// because Juno emits @junejs/core's PUBLIC trace contract (recordTableRead/Write),
// which makes cache() auto-tag by table and invokeAction auto-invalidate those
// tags. Any ORM that emits the same signals reaches the same tier.

import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, test } from "bun:test";

import {
  installTraceContext,
  runWithTrace,
  type RequestTrace,
} from "@junejs/core/instrumentation";
import { cache, memory, registerCache } from "@junejs/core/cache";
import { ACTION_REGISTRY, defineAction, invokeAction } from "@junejs/core/agent";
import { host } from "@junejs/server/host";

import { juno } from "../src";

// The host normally installs this; do it once for the test.
installTraceContext(new AsyncLocalStorage<RequestTrace>());

let n = 0;
const newTrace = (): RequestTrace => ({ id: `t${n++}`, startedAt: 0, events: [] });
const inTrace = <T>(fn: () => Promise<T>) => runWithTrace(newTrace(), fn);

afterEach(() => ACTION_REGISTRY.clear());

describe("Juno write → automatic cache invalidation", () => {
  test("no manual revalidate(): a write through Juno drops the cached read", async () => {
    registerCache(await memory().connect());
    const db = await host.openDb(":memory:");
    await db.exec("create table users (id integer primary key, name text)");
    await db.run("insert into users (name) values (?)", ["Ada"]);
    const j = juno(db);

    let computes = 0;
    const list = () =>
      inTrace(() =>
        cache(async () => {
          computes++;
          return j.table<{ name: string }>("users").all();
        }, { key: "users:list" }),
      );

    expect((await list()).length).toBe(1); // MISS → auto-tagged table:users
    expect((await list()).length).toBe(1); // HIT → no recompute
    expect(computes).toBe(1);

    // An action mutates through Juno. recordTableWrite("users") fires inside the
    // same trace as invokeAction, which then invalidates the table:users tag.
    defineAction({
      id: "addUser",
      description: "Add a user",
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async ({ name }: { name: string }) => {
        await j.table("users").insert({ name });
        return { ok: true };
      },
    });
    await inTrace(() => invokeAction("addUser", { name: "Linus" }));

    expect((await list()).length).toBe(2); // cache was dropped → recompute → 2
    expect(computes).toBe(2); // proof the cache really recomputed, not stale
  });
});

describe("the public trace contract Juno emits (Tier 3 is opt-in for any ORM)", () => {
  test("reads record table reads; writes record table writes", async () => {
    const db = await host.openDb(":memory:");
    await db.exec("create table posts (id integer primary key)");
    const j = juno(db);

    const r = newTrace();
    await runWithTrace(r, () => j.table("posts").all());
    expect([...(r.reads ?? [])]).toContain("posts");

    const w = newTrace();
    await runWithTrace(w, () => j.table("posts").insert({ id: 1 }));
    expect([...(w.writes ?? [])]).toContain("posts");
  });
});
