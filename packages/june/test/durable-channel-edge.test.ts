// Edge channel routing: durableChannelSurface mounts an agent's inbound channels on
// the Worker entry, resolves them from the worker env (so a Shape-B factory channel
// gets its signing secret at request time), verifies the signature, and routes the
// turn into the per-session Durable Object — posting the reply back out via waitUntil.
// Proven WITHOUT workerd: a fake DurableObjectNamespace (the repo's fake-bindings
// discipline, see worker-agent-edge.test.ts) + a captured global fetch for the
// reply-out. This is the helper that replaces a hand-rolled webhook + module-global
// signing-secret setter in the app's edge worker.

import { afterEach, describe, expect, test } from "bun:test";
import { crispChannel } from "@junejs/core/channels";
import type { ChannelFactory } from "@junejs/core/agent-config";
import { durableChannelSurface, type DurableObjectNamespace } from "../src/agent-durable";

const enc = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A fake DO namespace: records the addressed id + the forwarded turn body, and
// replies with a canned turn result — proving the WORKER-side routing, not the DO.
function fakeAgentNS() {
  let addressed: string | undefined;
  let forwarded: unknown;
  const ns: DurableObjectNamespace = {
    idFromName(name: string) { addressed = name; return { name }; },
    get() {
      return {
        async fetch(req: Request) { forwarded = await req.json(); return Response.json({ text: "DO replied" }); },
      };
    },
  };
  return { ns, addressed: () => addressed, forwarded: () => forwarded };
}

// Capture the outbound reply-out fetch (crisp REST). durableFetch goes through the
// namespace stub, not global fetch, so the only global fetch here is the reply.
let calls: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
function captureFetch() {
  calls = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

// Shape B: the channel module default-exports a factory of env — the form workerd
// needs (secrets live only in env). Reads its signing secret + REST creds from env.
const crispFactory: ChannelFactory = (env) => {
  const e = env as { CRISP_SIGNATURE_SECRET: string; CRISP_ID: string; CRISP_KEY: string };
  return crispChannel({ signingSecret: e.CRISP_SIGNATURE_SECRET, identifier: e.CRISP_ID, key: e.CRISP_KEY, apiUrl: "https://crisp.test" });
};

const AGENT = "crisp-support";
function envWith(ns: DurableObjectNamespace) {
  return { AGENT: ns, CRISP_SIGNATURE_SECRET: "sekret", CRISP_ID: "id", CRISP_KEY: "key" };
}
async function signedCrisp(secret: string, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await hmacHex(secret, `[${ts};${body}]`);
  return new Request("http://edge/channels/crisp", { method: "POST", headers: { "x-crisp-request-timestamp": ts, "x-crisp-signature": sig }, body });
}
const VISITOR = JSON.stringify({ event: "message:send", data: { from: "user", type: "text", content: "how many widgets?", website_id: "w1", session_id: "s1" } });

describe("durableChannelSurface (edge channel routing)", () => {
  test("a signed crisp webhook → session DO turn → reply posted back via waitUntil", async () => {
    captureFetch();
    const { ns, addressed, forwarded } = fakeAgentNS();
    const held: Promise<unknown>[] = [];
    const surface = durableChannelSurface(() => ns, {
      agentName: AGENT, channels: [crispFactory], env: envWith(ns), waitUntil: (p) => { held.push(p); },
    });

    const res = await surface(await signedCrisp("sekret", VISITOR));
    expect(res!.status).toBe(200);         // fast ACK
    expect(held).toHaveLength(1);          // background work kept alive on the edge, not floating
    await Promise.all(held);               // settle deterministically

    // routed to the per-session DO (agent : channel-derived session), forwarded on /turn:
    expect(addressed()).toBe(`${AGENT}:crisp:w1:s1`);
    expect(forwarded()).toEqual({ userText: "how many widgets?" }); // turnId undefined → omitted
    // reply-out went back to Crisp with the DO's turn text:
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://crisp.test/website/w1/conversation/s1/message");
    expect(calls[0]!.body).toMatchObject({ from: "operator", content: "DO replied" });
  });

  test("a bad signature is rejected (the env-resolved secret is actually enforced)", async () => {
    const { ns } = fakeAgentNS();
    const surface = durableChannelSurface(() => ns, { agentName: AGENT, channels: [crispFactory], env: envWith(ns) });
    const bad = new Request("http://edge/channels/crisp", {
      method: "POST", headers: { "x-crisp-request-timestamp": "1", "x-crisp-signature": "deadbeef" }, body: VISITOR,
    });
    expect((await surface(bad))!.status).toBe(401);
  });

  test("an operator (self) message runs no turn — loop guard", async () => {
    captureFetch();
    const { ns, addressed } = fakeAgentNS();
    const held: Promise<unknown>[] = [];
    const surface = durableChannelSurface(() => ns, { agentName: AGENT, channels: [crispFactory], env: envWith(ns), waitUntil: (p) => { held.push(p); } });
    const body = JSON.stringify({ event: "message:send", data: { from: "operator", type: "text", content: "our own reply", website_id: "w1", session_id: "s1" } });

    const res = await surface(await signedCrisp("sekret", body));
    expect(res!.status).toBe(200);
    await Promise.all(held);
    expect(addressed()).toBeUndefined(); // DO never addressed
    expect(calls).toHaveLength(0);
  });

  test("a non-channel path falls through (null)", async () => {
    const { ns } = fakeAgentNS();
    const surface = durableChannelSurface(() => ns, { agentName: AGENT, channels: [crispFactory], env: envWith(ns) });
    expect(await surface(new Request("http://edge/whatever", { method: "POST" }))).toBeNull();
  });
});
