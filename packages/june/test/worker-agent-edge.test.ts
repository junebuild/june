// Step 4 (edge): the durable agent surface on the built worker routes the chat
// endpoint to a per-session Durable Object bound at env.AGENT. Tested with a FAKE
// DurableObjectNamespace (the repo's fake-bindings discipline — see
// worker-env.test.ts's fakeD1), so it runs under bun:test with no workerd. The DO
// LOGIC itself is covered separately by agent-durable.test.ts (fake SqlStorage);
// a real-workerd smoke (wrangler dev) is the optional confidence layer.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { Channel } from "@junejs/core/agent-config";
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

// ── channel webhooks on the built worker (#139): manifest.agentChannels mounts
// the compiled module's channels via durableChannelSurface — factories resolve
// from THIS request's env, the turn runs on the session DO, and waitUntil comes
// from the invocation's execution context so post-ACK work survives the isolate.
describe("agent channel webhooks on the worker (edge)", () => {
  type Seen = { env?: unknown; hasWaitUntil?: boolean; ran?: string };
  const webhookChannel = (seen: Seen) => (env: unknown): Channel => ({
    name: "hook",
    path: "/channels/hook",
    webhook: async (req, ctx) => {
      seen.env = env;
      seen.hasWaitUntil = typeof ctx.waitUntil === "function";
      seen.ran = await ctx.run("from-webhook", { session: "s9" });
      return Response.json({ ok: true });
    },
  });

  test("a factory channel mounts at its path; env, DO routing, and waitUntil all arrive", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    manifest.agentName = "ops";
    const seen: Seen = {};
    manifest.agentChannels = [webhookChannel(seen)];
    const worker = createWorker(manifest);
    const { ns, addressed } = fakeAgentNS();
    const waited: Promise<unknown>[] = [];

    const res = await worker.fetch(
      new Request(ORIGIN + "/channels/hook", { method: "POST", body: "{}" }),
      { AGENT: ns, MARK: "env-1" },
      { waitUntil: (p) => void waited.push(p) },
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.ran).toBe("DO replied"); // ctx.run went through the session DO
    expect(addressed()).toBe("ops:s9");
    expect((seen.env as { MARK?: string }).MARK).toBe("env-1"); // factory resolved from THIS request's env
    expect(seen.hasWaitUntil).toBe(true); // the execution context reached the channel
  });

  test("interleaved fetches keep request-scoped env and waitUntil (no cross-request bleed)", async () => {
    // Two fetches in flight at once: A (the webhook) and B (any other request,
    // fired synchronously after A, finishing first). The pipeline awaits between
    // fetch entry and the agent surface, so an isolate-level "current request"
    // variable would hand A's webhook B's env/ctx — the regression this pins.
    const manifest = await buildManifest(FIXTURE_ROOT);
    manifest.agentName = "ops";
    const seen: { mark?: string }[] = [];
    const hook = (env: unknown): Channel => ({
      name: "hook",
      path: "/channels/hook",
      webhook: async (_req, ctx) => {
        ctx.waitUntil?.(Promise.resolve()); // background work → THIS invocation's ctx
        seen.push({ mark: (env as { MARK?: string }).MARK });
        return Response.json({ ok: true });
      },
    });
    manifest.agentChannels = [hook];
    const worker = createWorker(manifest);
    const { ns } = fakeAgentNS();
    const waitedA: Promise<unknown>[] = [];
    const waitedB: Promise<unknown>[] = [];

    const a = worker.fetch(
      new Request(ORIGIN + "/channels/hook", { method: "POST", body: "{}" }),
      { AGENT: ns, MARK: "A" },
      { waitUntil: (p) => void waitedA.push(p) },
    );
    const b = worker.fetch(new Request(ORIGIN + "/no-such-route"), { AGENT: ns, MARK: "B" }, { waitUntil: (p) => void waitedB.push(p) });
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(404);
    expect(seen[0]!.mark).toBe("A"); // the factory resolved with A's env, not B's
    expect(waitedA.length).toBe(1); // A's background work landed on A's invocation
    expect(waitedB.length).toBe(0);
  });

  test("agent.runtime.channels: false keeps webhooks unmounted (chat unaffected)", async () => {
    const manifest = await buildManifest(FIXTURE_ROOT);
    manifest.agentName = "ops";
    manifest.agent = { ...manifest.agent, runtime: { ...manifest.agent.runtime, channels: false } };
    const seen: Seen = {};
    manifest.agentChannels = [webhookChannel(seen)];
    const worker = createWorker(manifest);
    const { ns } = fakeAgentNS();

    const hook = await worker.fetch(new Request(ORIGIN + "/channels/hook", { method: "POST", body: "{}" }), { AGENT: ns });
    expect(hook.status).toBe(404); // not mounted
    const res = await worker.fetch(chat({ message: "hi", session: "s1" }), { AGENT: ns });
    expect(await res.json()).toEqual({ text: "DO replied" }); // the chat surface is independent
  });
});
