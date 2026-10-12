// Files as turn output (docs/rfc-agent-files.md): the FileRef marker, finding refs inside an
// arbitrary tool result, and the content-addressed stores. Content addressing is what makes a
// replayed remote tool idempotent, so it is asserted directly.

import { describe, expect, test } from "bun:test";
import { blobFileStore, fileRefsIn, isFileRef, memoryFileStore, type FileRef } from "@junejs/core/agent-files";
import type { JuneBlob } from "@junejs/core/resources";

const enc = new TextEncoder();
const PDF = { name: "report.pdf", mediaType: "application/pdf" };

function memoryBlob(): JuneBlob & { keys: () => string[] } {
  const m = new Map<string, Uint8Array>();
  return {
    async get(k) { return m.get(k) ?? null; },
    async put(k, d) { m.set(k, typeof d === "string" ? enc.encode(d) : d); },
    async delete(k) { m.delete(k); },
    async list(p = "") { return [...m.keys()].filter((k) => k.startsWith(p)); },
    keys: () => [...m.keys()],
  };
}

const ref = (id: string): FileRef => ({ $june: "file", id, name: `${id}.pdf`, mediaType: "application/pdf", size: 1 });

describe("isFileRef", () => {
  test("recognizes the marker and rejects look-alikes", () => {
    expect(isFileRef(ref("a"))).toBe(true);
    expect(isFileRef({ type: "file", id: "a", name: "a", mediaType: "x", size: 1 })).toBe(false);
    expect(isFileRef({ $june: "file", id: "a" })).toBe(false);
    expect(isFileRef(null)).toBe(false);
    expect(isFileRef("file")).toBe(false);
  });
});

describe("fileRefsIn", () => {
  test("finds a bare ref, nested refs and refs in arrays, deduped in order", () => {
    expect(fileRefsIn(ref("a"))).toEqual([ref("a")]);
    expect(fileRefsIn({ file: ref("a"), files: [ref("b"), ref("a")], note: "x" }).map((r) => r.id)).toEqual(["a", "b"]);
    expect(fileRefsIn({ report: { pdf: ref("c") } }).map((r) => r.id)).toEqual(["c"]);
  });

  test("stops at the depth cap and survives cycles and scalars", () => {
    expect(fileRefsIn({ a: { b: { c: { d: { e: ref("deep") } } } } })).toEqual([]);
    const cyclic: Record<string, unknown> = { file: ref("a") };
    cyclic.self = cyclic;
    expect(fileRefsIn(cyclic).map((r) => r.id)).toEqual(["a"]);
    expect(fileRefsIn("text")).toEqual([]);
    expect(fileRefsIn(undefined)).toEqual([]);
  });
});

describe("blobFileStore", () => {
  test("stores bytes under a content address and reads them back", async () => {
    const blob = memoryBlob();
    const files = blobFileStore(blob);
    const r = await files.put(enc.encode("%PDF-1.7"), PDF);
    expect(r).toEqual({ $june: "file", id: expect.stringMatching(/^[0-9a-f]{64}$/), name: "report.pdf", mediaType: "application/pdf", size: 8 });
    expect(blob.keys()).toEqual([`agent-files/${r.id}`]);
    expect(new TextDecoder().decode((await files.get(r.id))!)).toBe("%PDF-1.7");
  });

  test("the same bytes under another name share one stored object", async () => {
    const blob = memoryBlob();
    const files = blobFileStore(blob, { prefix: "f/" });
    const a = await files.put(enc.encode("same"), PDF);
    const b = await files.put(enc.encode("same"), { name: "again.pdf", mediaType: "application/pdf" });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("again.pdf");
    expect(blob.keys()).toEqual([`f/${a.id}`]);
  });

  test("refuses an id that is not a digest instead of reading another key", async () => {
    const blob = memoryBlob();
    await blob.put("secret", "s3cr3t");
    const files = blobFileStore(blob, { prefix: "" });
    expect(await files.get("secret")).toBeNull();
    expect(await files.get("../secret")).toBeNull();
    expect(await files.get("0".repeat(64))).toBeNull();
  });

  test("requires a name and a media type", async () => {
    const files = blobFileStore(memoryBlob());
    await expect(files.put(enc.encode("x"), { name: "", mediaType: "text/plain" })).rejects.toThrow(/name/);
    await expect(files.put(enc.encode("x"), { name: "x.txt", mediaType: "" })).rejects.toThrow(/mediaType/);
  });
});

describe("memoryFileStore", () => {
  test("round-trips and isolates callers from later mutation", async () => {
    const files = memoryFileStore();
    const data = enc.encode("abc");
    const r = await files.put(data, PDF);
    data[0] = 0;
    expect(new TextDecoder().decode((await files.get(r.id))!)).toBe("abc");
    expect(files.size).toBe(1);
    expect(await files.get("missing")).toBeNull();
  });
});
