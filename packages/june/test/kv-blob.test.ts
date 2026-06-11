// The kv (key-value, = cache reframed) and blob (object store) resources.
// Adapters tested directly against the JuneKv / JuneBlob contracts, plus that
// memoizeResources opens declared kv/blob handles for injection.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryKv } from "../src/kv";
import { localBlob } from "../src/blob";
import { memoizeResources } from "../src/resources";

describe("kv resource (memoryKv)", () => {
  test("put / get / delete round-trip", async () => {
    const kv = await memoryKv().open();
    expect(await kv.get("missing")).toBeNull();
    await kv.put("user:1", { name: "Ada" });
    expect(await kv.get<{ name: string }>("user:1")).toEqual({ name: "Ada" });
    await kv.delete("user:1");
    expect(await kv.get("user:1")).toBeNull();
  });

  test("ttl expires the entry", async () => {
    const kv = await memoryKv().open();
    await kv.put("flash", "x", { ttl: 0.01 });
    expect(await kv.get<string>("flash")).toBe("x");
    await new Promise((r) => setTimeout(r, 25));
    expect(await kv.get("flash")).toBeNull();
  });
});

describe("blob resource (localBlob)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "june-blob-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("put / get / list / delete with nested keys", async () => {
    const blob = await localBlob({ dir }).open();
    await blob.put("avatars/ada.txt", "hello");
    await blob.put("avatars/linus.txt", "world");
    expect(new TextDecoder().decode((await blob.get("avatars/ada.txt"))!)).toBe("hello");
    expect(await blob.get("nope.txt")).toBeNull();
    expect(await blob.list("avatars/")).toEqual(["avatars/ada.txt", "avatars/linus.txt"]);
    await blob.delete("avatars/ada.txt");
    expect(await blob.get("avatars/ada.txt")).toBeNull();
  });

  test("rejects path-traversal keys", async () => {
    const blob = await localBlob({ dir }).open();
    expect(blob.put("../escape.txt", "x")).rejects.toThrow("unsafe blob key");
    expect(blob.get("/etc/passwd")).rejects.toThrow("unsafe blob key");
  });
});

describe("memoizeResources opens declared kv + blob", () => {
  test("returns handles for declared resources only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "june-res2-"));
    const get = memoizeResources({ kv: memoryKv(), blob: localBlob({ dir }) });
    const res = await get();
    expect(res.kv).toBeDefined();
    expect(res.blob).toBeDefined();
    expect(res.db).toBeUndefined();
    // memoized: same handle instance across calls
    expect(await get()).toBe(res);
    await rm(dir, { recursive: true, force: true });
  });
});
