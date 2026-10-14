// The scenario the capability exists for (docs/rfc-agent-files.md): someone asks the agent
// in Slack for a PDF and gets the answer with the PDF attached in the thread. Everything is
// real — the native runtime, the durable turn, render_pdf on the Typst WASM compiler, the
// file store, the Slack channel — except the model (scripted) and Slack itself (fetch stub).

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { memoryFileStore } from "@junejs/core/agent-files";
import { defineAgent, parseSkill } from "@junejs/core/agent-config";
import { replyStream, type Model, type Msg } from "@junejs/core/agent-runtime";
import { slackChannel } from "@junejs/core/channels";
import { createAgentRuntime, mountAgent, toAgentDef } from "@junejs/server/agent-native";
import { pdfTools } from "@junejs/pdf";
import { typstRenderer } from "@junejs/pdf/typst";

const inter = new Uint8Array(await readFile(new URL("../../june/assets/icon-latin.ttf", import.meta.url)));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function signed(secret: string, body: string): Promise<Request> {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`)));
  const sig = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return new Request("http://app/channels/slack", { method: "POST", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body });
}

// Reads the skill, renders the report, then answers with a short note.
const model: Model = (msgs: Msg[]) => {
  const results = msgs.filter((m): m is Extract<Msg, { role: "tool" }> => m.role === "tool");
  if (results.length === 0) return replyStream({ text: "", toolCalls: [{ id: "c1", name: "read_skill", input: { name: "pdf-report" } }] });
  if (results.length === 1)
    return replyStream({
      text: "",
      toolCalls: [{ id: "c2", name: "render_pdf", input: { filename: "revenue-w41.pdf", lang: "en", markdown: "# Weekly revenue\n\nRevenue grew **12%**.\n\n| Region | Revenue |\n|:--|--:|\n| North | 21,000 |\n| South | 27,200 |" } }],
    });
  return replyStream({ text: "The weekly revenue report is attached: revenue grew 12%.", toolCalls: [] });
};

describe("Slack → agent → PDF attachment", () => {
  test("the reply posts in the thread, then the rendered PDF uploads into it", async () => {
    const calls: { method: string; body?: unknown; bytes?: Uint8Array }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://files.slack.test/")) {
        calls.push({ method: "UPLOAD", bytes: init!.body as Uint8Array });
        return new Response("OK");
      }
      const method = u.split("/").pop()!;
      const raw = init?.body as string | undefined;
      const form = new Headers(init?.headers).get("content-type")?.startsWith("application/x-www-form-urlencoded");
      calls.push({ method, body: raw ? (form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : undefined });
      if (method === "files.getUploadURLExternal") return Response.json({ ok: true, upload_url: "https://files.slack.test/u/F9", file_id: "F9" });
      return Response.json({ ok: true, ts: "2.2" });
    }) as typeof fetch;

    const slack = slackChannel({ signingSecret: "s3cret", botToken: "xoxb-test", apiUrl: "https://slack.test" });
    const skill = parseSkill("pdf-report", await readFile(new URL("../skills/pdf-report.md", import.meta.url), "utf8"));
    const agent = defineAgent({
      name: "analyst",
      tools: [pdfTools({ renderer: typstRenderer({ fonts: [inter], fontAssets: false }) })],
      skills: [skill],
      channels: [slack],
    });
    const files = memoryFileStore();
    const rt = await createAgentRuntime({ analyst: toAgentDef(agent, model) }, { backend: "native", files });
    try {
      const { fetch: channels } = mountAgent(agent, rt);
      const event = { type: "event_callback", event_id: "Ev1", event: { type: "app_mention", text: "<@UBOT> weekly revenue as a PDF please", channel: "C42", ts: "1.1", user: "U7" } };
      const res = await channels(await signed("s3cret", JSON.stringify(event)));
      expect(res!.status).toBe(200);

      for (let i = 0; i < 200 && !calls.some((c) => c.method === "files.completeUploadExternal"); i++) await new Promise((r) => setTimeout(r, 25));

      const order = calls.map((c) => c.method);
      expect(order.indexOf("chat.postMessage")).toBeLessThan(order.indexOf("files.getUploadURLExternal"));
      expect(calls.find((c) => c.method === "chat.postMessage")!.body).toMatchObject({ channel: "C42", thread_ts: "1.1", text: "The weekly revenue report is attached: revenue grew 12%." });
      expect(calls.find((c) => c.method === "files.getUploadURLExternal")!.body).toMatchObject({ filename: "revenue-w41.pdf" });
      const pdf = calls.find((c) => c.method === "UPLOAD")!.bytes!;
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
      expect(calls.find((c) => c.method === "files.completeUploadExternal")!.body).toMatchObject({ channel_id: "C42", thread_ts: "1.1" });
      expect(files.size).toBe(1);
    } finally {
      await rt.close();
    }
  }, 60_000);
});
