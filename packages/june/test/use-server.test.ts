// "use server" (Server Functions) feasibility — proves the React-spec machinery
// (registerServerReference / encodeReply / decodeReply) works in our worker-safe
// dual-graph build. NOT yet wired into the framework — this de-risks adding it.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundleServerGraph, bundleSsrGraph, referencesNodeBuiltins } from "../src/rsc-bundle";

const REPO = join(import.meta.dir, "..", "..", "..");
const FIX = join(import.meta.dir, "fixtures", "use-server");

let workdir: string;
beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "june-useserver-"));
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

// Write a bundle to import, each in its own fresh directory: Bun caches a
// directory's entries on the first import from it, so a second module written
// into the same directory afterwards fails "Cannot find module" (Bun 1.3.14 and
// 1.4.2). Run alone, this file failed the round-trip test; the full suite masked it.
function writeModule(name: string, code: string): string {
  const file = join(mkdtempSync(join(workdir, "m-")), name);
  writeFileSync(file, code);
  return file;
}

async function loadServer(): Promise<{
  renderWithAction: () => Promise<string>;
  callAdd: (body: string | FormData) => Promise<unknown>;
  code: string;
}> {
  const code = await bundleServerGraph(join(FIX, "server-entry.tsx"), REPO);
  const file = writeModule("us-server.mjs", code);
  const mod = (await import(file)) as {
    renderWithAction: () => Promise<string>;
    callAdd: (body: string | FormData) => Promise<unknown>;
  };
  return { ...mod, code };
}

describe('"use server" machinery (feasibility)', () => {
  test("a registered server action serializes as a SERVER reference in Flight (worker-safe)", async () => {
    const { renderWithAction, code } = await loadServer();
    const flight = await renderWithAction();
    // The action id appears as a server reference in the payload.
    expect(flight).toContain("actions#add");
    expect(referencesNodeBuiltins(code)).toBe(false);
  }, 30_000);

  test("client→server round trip: encodeReply (client graph) → decodeReply + invoke (server graph)", async () => {
    // Client graph encodes the call args (normal-react / edge conditions).
    const clientCode = await bundleSsrGraph(join(FIX, "client-entry.ts"), REPO);
    const clientFile = writeModule("us-client.mjs", clientCode);
    const { encode } = (await import(clientFile)) as {
      encode: (a: unknown[]) => Promise<string | FormData>;
    };
    const body = await encode([2, 3]);

    // Server graph decodes + runs the action.
    const { callAdd } = await loadServer();
    const result = await callAdd(body);
    expect(result).toBe(5);
    expect(referencesNodeBuiltins(clientCode)).toBe(false);
  }, 30_000);
});
