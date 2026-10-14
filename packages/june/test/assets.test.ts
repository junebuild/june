// assetCache (#383): a directory-backed loader for large files an unbundled entry leaves out.
// Every fetch goes through a stub; files land in a temp directory.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assetCache, type AssetRef } from "@junejs/server/assets";

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const fresh = async () => {
  if (dir) await rm(dir, { recursive: true, force: true }); // a test may start over
  return (dir = await mkdtemp(join(tmpdir(), "june-assets-")));
};

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");
const BYTES = new TextEncoder().encode("the engine, more or less");
const refOf = async (bytes = BYTES, urls = ["https://a.test/engine.wasm", "https://b.test/engine.wasm"]): Promise<AssetRef> => ({ name: "engine.wasm", sha256: await hex(bytes), size: bytes.length, urls });

// A fetch stand-in: each URL answers from `routes`; calls are recorded.
function server(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return routes[url]?.() ?? new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("assetCache", () => {
  test("downloads once into dir/<name>, then serves from disk, across instances too", async () => {
    await fresh();
    const ref = await refOf();
    const { calls, fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    const load = assetCache({ dir, fetch: fetcher });
    expect(await load(ref)).toEqual(BYTES);
    expect(await readFile(join(dir, "engine.wasm"))).toEqual(Buffer.from(BYTES));
    expect(await load(ref)).toEqual(BYTES);
    expect(await assetCache({ dir, fetch: fetcher })(ref)).toEqual(BYTES);
    expect(calls).toEqual(["https://a.test/engine.wasm"]);
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("concurrent requests for one file share a single download", async () => {
    await fresh();
    const { calls, fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    const load = assetCache({ dir, fetch: fetcher });
    const ref = await refOf();
    await Promise.all([load(ref), load(ref), load(ref)]);
    expect(calls.length).toBe(1);
  });

  test("a file on disk that doesn't match is replaced, never served", async () => {
    await fresh();
    await writeFile(join(dir, "engine.wasm"), "an older engine");
    const { calls, fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    expect(await assetCache({ dir, fetch: fetcher })(await refOf())).toEqual(BYTES);
    expect(calls.length).toBe(1);
    expect(await readFile(join(dir, "engine.wasm"))).toEqual(Buffer.from(BYTES));
  });

  test("a URL serving the wrong bytes falls through to the next; all failing names each", async () => {
    await fresh();
    const ok = server({ "https://a.test/engine.wasm": () => new Response("tampered!!tampered!!tamper"), "https://b.test/engine.wasm": () => new Response(BYTES) });
    expect(await assetCache({ dir, fetch: ok.fetcher })(await refOf())).toEqual(BYTES);
    expect(ok.calls).toEqual(["https://a.test/engine.wasm", "https://b.test/engine.wasm"]);

    await fresh();
    const bad = server({ "https://a.test/engine.wasm": () => new Response("x", { status: 503 }) });
    const err = await assetCache({ dir, fetch: bad.fetcher })(await refOf()).catch((e: Error) => e);
    expect(String(err)).toContain("engine.wasm could not be fetched (https://a.test/engine.wasm: HTTP 503; https://b.test/engine.wasm: HTTP 404)");
    expect(String(err)).toContain("offline: true");
    expect(await readdir(dir)).toEqual([]);
  });

  test("a download stops at the ref's size: by content-length, or by reading past it", async () => {
    await fresh();
    const big = new Uint8Array(1_000_000);
    const declared = server({ "https://a.test/engine.wasm": () => new Response(big, { headers: { "content-length": String(big.length) } }) });
    expect(String(await assetCache({ dir, fetch: declared.fetcher })(await refOf(BYTES, ["https://a.test/engine.wasm"])).catch((e) => e))).toContain(`1000000 bytes declared, expected ${BYTES.length}`);
    // No content-length: a stream that keeps going is cut one byte past the size.
    let pulled = 0;
    const endless = () => new Response(new ReadableStream({ pull: (c) => { pulled++; c.enqueue(new Uint8Array(16)); } }));
    const streamed = server({ "https://a.test/engine.wasm": endless });
    expect(String(await assetCache({ dir, fetch: streamed.fetcher })(await refOf(BYTES, ["https://a.test/engine.wasm"])).catch((e) => e))).toContain(`got ${BYTES.length + 1} bytes`);
    expect(pulled).toBeLessThan(5);
  });

  test("a body that reaches the cap and then stalls is cancelled, not waited on", async () => {
    await fresh();
    // Exactly size + 1 bytes, then the stream stays open forever.
    const stalls = () => new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(BYTES.length + 1)) }));
    const { fetcher } = server({ "https://a.test/engine.wasm": stalls });
    const outcome = await Promise.race([
      assetCache({ dir, fetch: fetcher })(await refOf(BYTES, ["https://a.test/engine.wasm"])).catch((e) => String(e)),
      new Promise((r) => setTimeout(() => r("hung"), 1000)),
    ]);
    expect(outcome).toContain(`got ${BYTES.length + 1} bytes`);
  });

  test("refs that differ only in size don't share a download", async () => {
    await fresh();
    const { fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    const load = assetCache({ dir, fetch: fetcher });
    const ref = await refOf(BYTES, ["https://a.test/engine.wasm"]);
    const [good, wrong] = await Promise.allSettled([load(ref), load({ ...ref, size: ref.size + 1 })]);
    expect(good.status).toBe("fulfilled");
    expect(wrong.status).toBe("rejected");
  });

  test("offline: serves what was copied in, never fetches, and says what to copy", async () => {
    await fresh();
    const { calls, fetcher } = server({});
    const load = assetCache({ dir, offline: true, fetch: fetcher });
    const ref = await refOf();
    const err = String(await load(ref).catch((e) => e));
    expect(err).toContain(`engine.wasm is not in ${dir}, and this cache is offline: copy the file with sha256 ${ref.sha256} (${BYTES.length} bytes) to ${join(dir, "engine.wasm")}`);
    await writeFile(join(dir, "engine.wasm"), "not it");
    expect(String(await load(ref).catch((e) => e))).toContain("but doesn't match");
    await writeFile(join(dir, "engine.wasm"), BYTES);
    expect(await load(ref)).toEqual(BYTES);
    expect(calls).toEqual([]);
  });

  test("urls: fetches from the app's mirror instead of the ref's", async () => {
    await fresh();
    const { calls, fetcher } = server({ "https://mirror.internal/engine.wasm": () => new Response(BYTES) });
    await assetCache({ dir, fetch: fetcher, urls: (r) => [`https://mirror.internal/${r.name}`] })(await refOf());
    expect(calls).toEqual(["https://mirror.internal/engine.wasm"]);
  });

  test("egress: the hosts still to contact; [] once cached, or offline", async () => {
    await fresh();
    const { fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    const load = assetCache({ dir, fetch: fetcher });
    const ref = await refOf();
    expect(await load.egress([ref])).toEqual([{ host: "a.test", sends: "nothing" }, { host: "b.test", sends: "nothing" }]);
    expect(await load.cached(ref)).toBe(false);
    await load(ref);
    expect(await load.cached(ref)).toBe(true);
    expect(await load.egress([ref])).toEqual([]);
    expect(await assetCache({ dir, offline: true }).egress([{ ...ref, sha256: "0".repeat(64) }])).toEqual([]);
  });

  test("a name that would leave the directory is refused before anything is fetched", async () => {
    await fresh();
    const { calls, fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    for (const name of ["../escape", "a/b", "..", ""]) {
      for (const offline of [true, false]) {
        expect(String(await assetCache({ dir, offline, fetch: fetcher })({ ...(await refOf()), name }).catch((e) => e))).toContain("unsafe asset name");
      }
    }
    expect(calls).toEqual([]);
  });

  test("a read error other than a missing file is reported, not taken for a miss", async () => {
    await fresh();
    await mkdir(join(dir, "engine.wasm")); // a directory where the file should be
    const { calls, fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    await expect(assetCache({ dir, fetch: fetcher })(await refOf())).rejects.toThrow(/engine\.wasm/);
    expect(calls).toEqual([]);
  });

  test("two names with the same content each get their file", async () => {
    await fresh();
    const { fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    const load = assetCache({ dir, fetch: fetcher });
    const ref = await refOf(BYTES, ["https://a.test/engine.wasm"]);
    await Promise.all([load(ref), load({ ...ref, name: "copy.wasm" })]);
    expect((await readdir(dir)).sort()).toEqual(["copy.wasm", "engine.wasm"]);
  });

  test("a sweep that fails doesn't fail the download, then or later", async () => {
    await fresh();
    // A stale ".tmp" the sweep can't remove: a non-empty directory.
    const stuck = join(dir, ".june-tmp-stuck");
    await mkdir(stuck);
    await writeFile(join(stuck, "inside"), "x");
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stuck, hourAgo, hourAgo);
    const { fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES), "https://a.test/copy.wasm": () => new Response(BYTES) });
    const load = assetCache({ dir, fetch: fetcher });
    expect(await load(await refOf(BYTES, ["https://a.test/engine.wasm"]))).toEqual(BYTES);
    expect(await load({ ...(await refOf(BYTES, ["https://a.test/copy.wasm"])), name: "copy.wasm" })).toEqual(BYTES);
  });

  test("the sweep removes only the cache's own temp files, never an asset", async () => {
    await fresh();
    const asset = join(dir, ".model.tmp"); // a legitimate asset name that merely looks temporary
    await writeFile(asset, "a model");
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(asset, hourAgo, hourAgo);
    const { fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    await assetCache({ dir, fetch: fetcher })(await refOf());
    expect(await readFile(asset, "utf8")).toBe("a model");
    // The temp prefix is reserved, so no asset can be mistaken for one.
    expect(String(await assetCache({ dir, offline: true })({ ...(await refOf()), name: ".june-tmp-x" }).catch((e) => e))).toContain("unsafe asset name");
  });

  test("temp files from a crashed download are swept once stale; a young one is left alone", async () => {
    await fresh();
    const stale = join(dir, ".june-tmp-old-engine.wasm");
    const young = join(dir, ".june-tmp-young-engine.wasm");
    await writeFile(stale, "half");
    await writeFile(young, "in progress elsewhere");
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, hourAgo, hourAgo);
    const { fetcher } = server({ "https://a.test/engine.wasm": () => new Response(BYTES) });
    await assetCache({ dir, fetch: fetcher })(await refOf());
    expect(await stat(stale).then(() => true, () => false)).toBe(false);
    expect(await stat(young).then(() => true, () => false)).toBe(true);
  });
});
