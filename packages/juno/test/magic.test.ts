// THE FLAGSHIP: a Juno write auto-invalidates a Juno read's cache with ZERO
// manual revalidate(). This is the agent-native differentiator — it works
// because Juno emits @junejs/core's PUBLIC trace contract (recordTableRead/Write),
// which makes cache() auto-tag by table and invokeAction auto-invalidate those
// tags. Any ORM that emits the same signals reaches the same tier.

import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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

// Empty registry per test, restored after — see core's discovery.test.ts: a
// cleared registry cannot be repopulated by re-import (module cache), which
// breaks later test files.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => {
  preexisting = new Map(ACTION_REGISTRY);
  ACTION_REGISTRY.clear();
});
afterEach(() => {
  ACTION_REGISTRY.clear();
  for (const [id, action] of preexisting) ACTION_REGISTRY.set(id, action);
});

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

  test("a RAW query through j.db inside cache() auto-tags (no silent staleness)", async () => {
    registerCache(await memory().connect());
    const db = await host.openDb(":memory:");
    await db.exec("create table posts (id integer primary key, title text)");
    await db.run("insert into posts (title) values (?)", ["hello"]);
    const j = juno(db);

    let computes = 0;
    const list = () =>
      inTrace(() =>
        cache(async () => {
          computes++;
          // The eval-v2 footgun: a raw query inside cache(). The handle's db parses
          // "posts" and records the read, so it is tagged like the table API.
          return j.db.query<{ id: number }>("select id from posts");
        }, { key: "posts:raw" }),
      );

    expect((await list()).length).toBe(1); // MISS → auto-tagged table:posts via parse
    expect((await list()).length).toBe(1); // HIT
    expect(computes).toBe(1);

    defineAction({
      id: "addPost",
      description: "Add a post",
      input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      run: async ({ title }: { title: string }) => {
        await j.table("posts").insert({ title });
        return { ok: true };
      },
    });
    await inTrace(() => invokeAction("addPost", { title: "world" }));

    expect((await list()).length).toBe(2); // raw-query cache dropped → recompute, not stale
    expect(computes).toBe(2);
  });

  test("explicit j.reads()/j.writes() tag + invalidate when SQL can't be parsed", async () => {
    registerCache(await memory().connect());
    const j = juno(await host.openDb(":memory:"));

    let computes = 0;
    const derived = () =>
      inTrace(() =>
        cache(async () => {
          computes++;
          j.reads("notifications"); // explicit anchor for a non-SQL / computed read
          return 42;
        }, { key: "derived" }),
      );

    expect(await derived()).toBe(42);
    expect(await derived()).toBe(42);
    expect(computes).toBe(1); // HIT

    defineAction({
      id: "touch",
      description: "touch notifications",
      input: { type: "object", properties: {}, required: [] },
      run: async () => {
        j.writes("notifications"); // explicit invalidate hatch (no write statement)
        return { ok: true };
      },
    });
    await inTrace(() => invokeAction("touch", {}));

    expect(await derived()).toBe(42);
    expect(computes).toBe(2); // j.writes() dropped the tag → recompute
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
