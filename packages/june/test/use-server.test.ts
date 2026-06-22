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

async function loadServer(): Promise<{
  renderWithAction: () => Promise<string>;
  callAdd: (body: string | FormData) => Promise<unknown>;
  code: string;
}> {
  const code = await bundleServerGraph(join(FIX, "server-entry.tsx"), REPO);
  const file = join(workdir, "us-server.mjs");
  writeFileSync(file, code);
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
    const clientFile = join(workdir, "us-client.mjs");
    writeFileSync(clientFile, clientCode);
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
