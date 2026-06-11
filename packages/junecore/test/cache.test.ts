import { beforeEach, describe, expect, test } from "bun:test";
import { cache, invalidate, memory, registerCache } from "junecore/cache";

// Each test starts on a fresh in-memory store so keys/tags don't leak across tests.
beforeEach(async () => {
  registerCache(await memory().connect());
});

describe("cache()", () => {
  test("memoizes — fn runs once across repeated calls with the same key", async () => {
    let calls = 0;
    const run = () => cache(async () => ++calls, { key: "k" });
    expect(await run()).toBe(1);
    expect(await run()).toBe(1);
    expect(calls).toBe(1);
  });

  test("recomputes after a ttl expiry", async () => {
    let calls = 0;
    const run = () => cache(async () => ++calls, { key: "k", ttl: 0.01 });
    expect(await run()).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(await run()).toBe(2);
  });
});

describe("invalidate()", () => {
  test("drops every entry carrying a tag", async () => {
    let calls = 0;
    const run = () => cache(async () => ++calls, { key: "k", tags: ["users"] });
    expect(await run()).toBe(1);
    await invalidate("users");
    expect(await run()).toBe(2);
  });

  test("leaves entries without the tag untouched", async () => {
    let a = 0;
    let b = 0;
    const runA = () => cache(async () => ++a, { key: "a", tags: ["users"] });
    const runB = () => cache(async () => ++b, { key: "b", tags: ["posts"] });
    await runA();
    await runB();
    await invalidate("users");
    expect(await runA()).toBe(2); // recomputed
    expect(await runB()).toBe(1); // untouched
  });
});
