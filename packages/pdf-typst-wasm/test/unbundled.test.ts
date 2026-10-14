// The unbundled entry (#383): the renderer gets its engine from the app's loader, checked
// against the ref this build wrote. Skipped, with the command to run, when the engine and its
// ref aren't built; loadVerified needs neither.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PdfRenderError } from "@junejs/pdf";
import { loadVerified, typstWasmAsset, typstWasmRenderer, type AssetRef } from "@junejs/pdf-typst-wasm/unbundled";

const WASM = new URL("../dist/typst.wasm", import.meta.url);
const built = existsSync(fileURLToPath(new URL("../dist/typst.wasm.ref.json", import.meta.url)));
if (!built) console.warn("[pdf-typst-wasm] dist/typst.wasm.ref.json is missing — run `bun run build` in packages/pdf-typst-wasm to run these tests");

const sha256 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("loadVerified", () => {
  const bytes = new TextEncoder().encode("an asset");
  const ref = async (): Promise<AssetRef> => ({ name: "a.bin", sha256: await sha256(bytes), size: bytes.length, urls: ["https://example.test/a.bin"] });

  test("returns the loader's bytes when size and sha256 match, ArrayBuffer or Uint8Array", async () => {
    expect(await loadVerified(await ref(), async () => bytes)).toEqual(bytes);
    expect(await loadVerified(await ref(), async () => bytes.slice().buffer)).toEqual(bytes);
  });

  test("rejects bytes of the wrong size or digest, naming the file", async () => {
    const r = await ref();
    await expect(loadVerified(r, async () => bytes.slice(1))).rejects.toThrow(/a\.bin: the loader returned 7 bytes, expected 8/);
    const tampered = bytes.slice();
    tampered[0] = 0x41;
    await expect(loadVerified(r, async () => tampered)).rejects.toThrow(/a\.bin: the loader returned bytes with sha256 [0-9a-f]{64}, expected/);
  });
});

describe("typstWasmRenderer (unbundled)", () => {
  test("declares the engine's hosts until told the engine is pre-seeded", () => {
    const load = async () => new Uint8Array();
    expect(typstWasmRenderer({ load }).egress).toEqual([
      { host: "cdn.jsdelivr.net", sends: "nothing" },
      { host: "unpkg.com", sends: "nothing" },
    ]);
    expect(typstWasmRenderer({ load, engineEgress: [] }).egress).toEqual([]);
  });

  describe.skipIf(!built)("with the built engine", () => {
    test("the ref describes the file this build wrote, at this version's URLs", async () => {
      const ref = await typstWasmAsset();
      const bytes = new Uint8Array(await readFile(WASM));
      const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      expect(ref).toEqual({ name: "typst.wasm", sha256: await sha256(bytes), size: bytes.length, urls: expect.arrayContaining([`https://cdn.jsdelivr.net/npm/@junejs/pdf-typst-wasm@${version}/dist/typst.wasm`]) });
    });

    test("loads the engine once, through the app's loader, given its ref", async () => {
      const asked: AssetRef[] = [];
      const r = typstWasmRenderer({ load: async (ref) => (asked.push(ref), readFile(WASM)) });
      await r.render({ markdown: "# One" });
      await r.render({ markdown: "# Two" });
      expect(asked.map((a) => a.name)).toEqual(["typst.wasm"]);
    });

    test("an engine that isn't the release's is never run, and the next render retries", async () => {
      let calls = 0;
      const r = typstWasmRenderer({ load: async () => (++calls === 1 ? new Uint8Array(30) : readFile(WASM)) });
      await expect(r.render({ markdown: "# A" })).rejects.toThrow(/typst\.wasm: the loader returned 30 bytes/);
      const err = await r.render({ markdown: "季報" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PdfRenderError); // it ran: no CJK font, so a missing glyphs error
      expect(calls).toBe(2);
    });
  });
});
