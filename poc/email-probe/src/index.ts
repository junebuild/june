// june-email-probe — observes the Cloudflare Email Service behaviors the email
// RFC (docs/rfc-email.md §13) could not settle from the docs. It records what
// it sees and decides nothing; the README turns the records into answers.

import { DurableObject } from "cloudflare:workers";

type Env = {
  EMAIL: { send(message: unknown): Promise<{ messageId: string }> };
  LOG: DurableObjectNamespace<ProbeLog>;
  PROBE_KEY: string;
};

const FROM = "probe@agents.june.build";

// Append-only record of every observation, in one SQLite-backed object.
export class ProbeLog extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, data TEXT)",
    );
  }
  add(kind: string, data: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (at, kind, data) VALUES (?, ?, ?)",
      new Date().toISOString(),
      kind,
      JSON.stringify(data),
    );
  }
  list(limit: number): unknown[] {
    return this.ctx.storage.sql
      .exec("SELECT id, at, kind, data FROM events ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((r) => ({ ...r, data: JSON.parse(String(r.data)) }));
  }
}

function log(env: Env, kind: string, data: unknown): Promise<void> {
  console.log(JSON.stringify({ kind, data }));
  return env.LOG.get(env.LOG.idFromName("probe")).add(kind, data);
}

// The header block in wire order, unfolded, duplicates kept. `Headers` would
// merge repeated fields, and test 1 is about which copy of a repeated field
// (Authentication-Results) came from whom.
function headerBlock(raw: string): { name: string; value: string }[] {
  const end = raw.search(/\r?\n\r?\n/);
  const out: { name: string; value: string }[] = [];
  for (const line of (end === -1 ? raw : raw.slice(0, end)).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]!.value += " " + line.trim();
    else {
      const i = line.indexOf(":");
      if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
  }
  return out;
}

const KEPT = new Set([
  "authentication-results",
  "arc-authentication-results",
  "arc-seal",
  "received-spf",
  "message-id",
  "in-reply-to",
  "references",
  "from",
  "to",
  "subject",
  "x-probe",
]);

export default {
  // Tests 1, 2 and 4: what an inbound message looks like to the Worker.
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).text();
    const headers = headerBlock(raw);
    await log(env, "inbound", {
      envelope: { from: message.from, to: message.to },
      rawSize: message.rawSize,
      order: headers.map((h) => h.name), // every field name, top (newest hop) first
      kept: headers.filter((h) => KEPT.has(h.name.toLowerCase())),
      dkimSignatures: headers
        .filter((h) => h.name.toLowerCase() === "dkim-signature")
        .map((h) => ({ d: /\bd=([^;\s]+)/.exec(h.value)?.[1], s: /\bs=([^;\s]+)/.exec(h.value)?.[1] })),
      received: headers.filter((h) => h.name.toLowerCase() === "received").slice(0, 3).map((h) => h.value),
    });
    // Neither forward nor reject: the message is accepted and kept only in the log.
  },

  // Test 3: Email Sending delivery events.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      await log(env, "delivery-event", m.body);
      m.ack();
    }
  },

  // Operator endpoints, behind PROBE_KEY:
  //   GET  /events?limit=N                       the log, newest first
  //   POST /send  {to, subject?, headers?}        a send through the binding (tests 3, 5)
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.PROBE_KEY || req.headers.get("authorization") !== `Bearer ${env.PROBE_KEY}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/events") {
      // A positive integer, capped: SQLite reads `LIMIT -1` as no limit and rejects fractions.
      const n = Math.trunc(Number(url.searchParams.get("limit") ?? 50));
      const limit = n > 0 ? Math.min(n, 500) : 50;
      return Response.json(await env.LOG.get(env.LOG.idFromName("probe")).list(limit));
    }
    if (req.method === "POST" && url.pathname === "/send") {
      const body = (await req.json()) as { to: string; subject?: string; headers?: Record<string, string> };
      const probe = crypto.randomUUID();
      const message = {
        from: FROM,
        to: body.to,
        subject: body.subject ?? `june-email-probe ${probe}`,
        text: `Probe ${probe}. Sent by the june-email-probe Worker (docs/rfc-email.md §13).`,
        // The generated X-Probe wins over a caller's copy in any case, so the logged UUID is the one delivered.
        headers: {
          ...Object.fromEntries(Object.entries(body.headers ?? {}).filter(([k]) => k.toLowerCase() !== "x-probe")),
          "X-Probe": probe,
        },
      };
      try {
        const result = await env.EMAIL.send(message);
        await log(env, "send", { probe, to: body.to, result });
        return Response.json({ probe, result });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        await log(env, "send-error", { probe, to: body.to, code: e.code, message: e.message });
        return Response.json({ probe, error: { code: e.code, message: e.message } }, { status: 502 });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
