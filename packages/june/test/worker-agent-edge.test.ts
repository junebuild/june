// Step 4 (edge): the durable agent surface on the built worker routes the chat
// endpoint to a per-session Durable Object bound at env.AGENT. Tested with a FAKE
// DurableObjectNamespace (the repo's fake-bindings discipline — see
// worker-env.test.ts's fakeD1), so it runs under bun:test with no workerd. The DO
// LOGIC itself is covered separately by agent-durable.test.ts (fake SqlStorage);
// a real-workerd smoke (wrangler dev) is the optional confidence layer.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { buildManifest } from "../src/build";
import { createWorker } from "../src/worker";
import type { DurableObjectNamespace } from "../src/agent-durable";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/db", import.meta.url));
const ORIGIN = "http://june.test";

// A fake DO namespace: records which id was addressed + the forwarded body, and
// replies with a canned turn result — proving the WORKER routing, not the DO.
function fakeAgentNS() {
  let addressed: string | undefined;
  let forwarded: unknown;
  const ns: DurableObjectNamespace = {
    idFromName(name: string) {
      addressed = name;
      return { name };
    },
    get() {
      return {
        async fetch(req: Request) {
          forwarded = await req.json();
          // the DO streams SSE now; a non-streaming /message collapses it to { text }
          const frame = `data: ${JSON.stringify({ type: "turn.completed", turnId: "t1", text: "DO replied" })}\n\n`;
          return new Response(frame, { headers: { "content-type": "text/event-stream" } });
        },
      };
    },
  };
  return { ns, addressed: () => addressed, forwarded: () => forwarded };
}

const chat = (body: unknown) => new Request(ORIGIN + "/message", { method: "POST", body: JSON.stringify(body) });

describe("durable agent surface on the worker (edge)", () => {
  test("POST /message routes to the session DO at env.AGENT", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    manifest.agentName = "ops";
    const worker = createWorker(manifest);
    const { ns, addressed, forwarded } = fakeAgentNS();

    const res = await worker.fetch(chat({ message: "hi", session: "s1" }), { AGENT: ns });
    expect(await res.json()).toEqual({ text: "DO replied" }); // SSE collapsed to JSON (default)
    expect(addressed()).toBe("ops:s1"); // the right per-session DO instance
    expect(forwarded()).toEqual({ userText: "hi" }); // forwarded on the DO's /turn contract
  });

  test("POST /message with Accept: text/event-stream pipes the DO's SSE through (live chat)", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    manifest.agentName = "ops";
    const worker = createWorker(manifest);
    const { ns } = fakeAgentNS();
    const req = new Request(ORIGIN + "/message", { method: "POST", headers: { accept: "text/event-stream" }, body: JSON.stringify({ message: "hi", session: "s1" }) });
    const res = await worker.fetch(req, { AGENT: ns });
    expect(res.headers.get("content-type")).toBe("text/event-stream"); // streamed, not collapsed
    expect(await res.text()).toContain('"type":"turn.completed"');
  });

  test("no env.AGENT binding → surface is inert, request falls through", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    manifest.agentName = "ops";
    const worker = createWorker(manifest);
    const res = await worker.fetch(chat({ message: "hi" }), {});
    expect(res.status).toBe(404); // no DO → null → routing → not a route → 404
  });

  test("no agent (manifest.agentName unset) → no agent surface at all", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    const worker = createWorker(manifest);
    const { ns, addressed } = fakeAgentNS();
    const res = await worker.fetch(chat({ message: "hi" }), { AGENT: ns });
    expect(res.status).toBe(404);
    expect(addressed()).toBeUndefined(); // the DO was never addressed
  });
});
