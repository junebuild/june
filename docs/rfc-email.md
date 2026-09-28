# RFC: Email — every agent owns a mailbox

Status: **proposal / draft** · Stage: v0 (no back-compat constraint) · Scope: a new
`@junejs/email` package, the edge worker entries (`email()`, `queue()`), the durable host
(alarms), `june build`'s emitted wrangler config, the channel contract (`InboundEvent`).

## Summary

Every agent built with June can have **its own email address and its own mailbox**: it
receives mail (a turn per inbound message, one session per thread), keeps it (a mailbox it
can search and re-read), acts on it (draft, send, follow up — as tools), and replies (a turn's
output delivered as a threaded email).

The agent **owns** the mailbox. It is not an assistant operating a human's inbox; it is a
correspondent in its own right, with an address like `scout@agents.example.com`. That one
decision shapes the whole design (§2).

Providers are transports under a June-owned mailbox:

| provider | inbound | outbound |
| --- | --- | --- |
| Cloudflare Email Service (Email Routing + Email Sending) | yes | yes |
| Google Workspace (Gmail API, an account the agent owns) | yes | yes |
| AWS SES | yes | yes |
| Resend | yes | yes |
| Mailgun | yes | yes |
| SMTP | — | yes |
| IMAP / POP3 | yes | — |

Mechanically, email is a `Channel` (the world comes in) plus tools (the agent reaches out),
exactly like Slack and Google Drive. What is new: seven providers must fit one contract, the
mailbox is state June keeps, and email is the **least trusted inbound surface June has ever
had** — anyone on the internet can start a turn.

## 1. Motivation and prior art

Email is where most business processes still live: support, sales, vendor ops, approvals.
An agent that can only talk in Slack cannot answer the customer who wrote in, and cannot
write first to a supplier.

[cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) is the clearest
reference design. What June keeps:

- **The mailbox is local state**: SQLite for messages and full-text search, R2 for attachments.
- **Auto-draft, gated send**: every inbound message gets a drafted reply; nothing is sent
  without approval.
- **Mail tools on `/mcp`**: external agents (Claude Code, Cursor) operate the mailbox.

Where June differs:

- **Who owns the mailbox**: agentic-inbox is a human's email client with an AI assistant.
  June's mailbox belongs to the agent (§2).
- **Authorization**: agentic-inbox's only trust boundary is one Cloudflare Access policy —
  anyone past it reads every mailbox. June has per-call identity (`Principal`,
  `requiresPrincipal`) and uses it per mailbox.
- **Portability**: agentic-inbox is Cloudflare-only. June runs on native and edge, and the
  provider is a swappable adapter.

Cloudflare's "email for agents" launch (Email Sending public beta, 2026-04-16) contributes one
pattern:
**signed reply routing** — the address a reply goes to encodes which agent instance should
receive it, HMAC-signed so a forged header cannot route mail into an arbitrary instance. June
adopts it as its primary reply-routing mechanism (§6), for a reason specific to Cloudflare's
sending API (§5).

## 2. The ownership model

"The agent owns its mailbox" has concrete consequences:

1. **An address is part of the agent's definition.** The agent config (`agent/agent.ts`)
   gains an `email.address`; the provider and send policy live in `agent/channels/email.ts`. The address is the agent's identity on the wire:
   `From:` on everything it sends, the routing key for everything it receives.
2. **June stores the mail, always.** The provider is a transport; the mailbox — messages,
   threads, attachments, delivery status — lives in June's own store. Search never depends on
   a provider search API (SES, Resend and Mailgun have none), and moving providers does not
   lose history. For Gmail and IMAP this means the agent has **its own account** (a Workspace
   seat, an IMAP login) and June syncs it into the store; June does not browse a human's inbox
   in place.
3. **One session per thread.** Each email thread is one agent session (one Durable Object on
   the edge), so a thread's transcript stays small and a turn only replays its own
   conversation. The mailbox store is the agent-wide view across threads: `search` and
   `list_threads` read it, a turn in thread A can look up thread B.
4. **Correspondents are not users.** People who write to the agent are external parties, not
   principals of the app. The app's own operators are principals; the send policy (§7) is
   about how much autonomy the operators grant the agent.
5. **The agent can write first.** A proactive turn (`receive()`, §9 of the live-turn RFC) can
   open a new thread; the new thread gets a session the moment its first message is sent.

## 3. Current architecture — what exists, what is missing

Exists, reused as-is:

- `Channel` (`packages/core/src/agent-config.ts`): `webhook`, `deliver`, `post`, `tools`, plus
  the `ChannelExtensions` seams (`mode`, `accept`, `onEvent`, `onRejected`).
- `InboundEvent` (`packages/core/src/agent-runtime.ts`) with `principal` for verified identity.
- HITL: `ctx.requestInput` parks a turn; `resumeDelivered` / `deliverResume` render the
  continuation. Cross-channel delivery: `deliver(target, events)`.
- Per-call `auth(ctx)` credentials, as in `google-drive.ts` — tokens never reach the model.
- `db` and `blob` resources (D1 / SQLite / Postgres; R2 / S3 / local dir) with plain-SQL
  migrations.

Missing (verified against `main` at b5f0dfd, 2026-09-28):

1. **No `email()` entry on the edge worker.** `createWorker` (`packages/june/src/worker.ts`)
   returns `{ fetch }` only, and the adapter wraps it as `export default { fetch }`. Cloudflare
   Email Routing delivers to a Worker's `email(message, env, ctx)` export.
2. **No `queue()` entry.** Cloudflare publishes outbound delivery events (delivered, bounced,
   complained, …) only to a Queue (§5).
3. **No scheduled work on the durable host.** `agent-durable.ts` has no `alarm()`. IMAP polling
   and Gmail `watch` renewal (expires after 7 days) need one.
4. **`InboundEvent` has no email shape**: sender authentication, recipients, thread key.
5. **`june deploy` pins `wrangler@4.99.0`** (`packages/june/src/deploy.ts`). Declaring inbound
   addresses in wrangler config (`addresses`) needs Wrangler ≥ 4.113.0.

## 4. Design principles

1. **The mailbox is June's.** Providers move bytes; June keeps state (§2.2).
2. **Normalize on raw MIME.** Every inbound path ends in an RFC 5322 message; one parser, one
   test corpus. Provider JSON is a transport detail, never the model's input.
3. **Adapters by delivery pattern, not by vendor.** Seven providers reduce to three inbound
   patterns and two outbound shapes (§5).
4. **Inbound is untrusted by default.** A `From:` header is a claim. Identity comes from
   authentication results plus a resolver, or it does not come at all.
5. **Sending is gated by default.** Autonomy is granted by the operator, per correspondent
   (§7).
6. **Transport only.** Per #149, the channel carries no behavior. Tone, escalation rules and
   signatures live in `instructions.email.md` or a skill.
7. **Web-standard core.** Parsing, threading, safety and the HTTP providers run on native and
   edge. Only socket protocols (SMTP, IMAP) touch runtime-specific APIs, behind a subpath.

## 5. Provider model

### Inbound: three patterns

| pattern | providers | shape |
| --- | --- | --- |
| **push** — the full message arrives | Cloudflare Email Routing, Mailgun Routes (`message-mime`), SES → SNS (≤ 150 KB) | verify → raw MIME |
| **notify** — a pointer arrives, then fetch | Gmail (`users.watch` → Pub/Sub → `history.list`), SES → S3 + SNS, Resend (`email.received` carries metadata only; body and attachments are separate API calls) | verify → cursor → fetch since cursor |
| **poll** — nothing arrives | IMAP, POP3 | alarm → fetch since cursor |

```ts
// packages/email — sketch, names not final
type RawMime = { bytes: Uint8Array; envelope?: { from: string; to: string }; providerId?: string; receivedAt: number };

type EmailInbound =
  | { kind: "push"; receive(input: Request | ForwardableEmailMessage): Promise<RawMime[]> }
  | { kind: "notify"; verify(req: Request): Promise<Cursor | null>;
      fetchSince(c: Cursor): Promise<{ mails: RawMime[]; next: Cursor }> }
  | { kind: "poll"; interval: number;
      fetchSince(c: Cursor): Promise<{ mails: RawMime[]; next: Cursor }> };
```

The cursor is persisted in the mailbox store (Gmail `historyId`; IMAP `UIDVALIDITY` +
`UIDNEXT`; S3 key). A `UIDVALIDITY` change or a Gmail `404 historyId` means the cursor is gone
and a bounded resync is required; the adapter reports it rather than silently skipping mail.
Whatever the pattern, ingestion ends the same way: parse → dedupe → write to the store → start
a turn on the thread's session.

### Outbound: two shapes

```ts
type EmailOutbound = {
  send(msg: OutboundEmail): Promise<{ providerId: string; messageId?: string }>;
  capabilities: { rawMime: boolean; ownMessageId: boolean; maxBytes: number; maxRecipients: number };
};
```

- **raw MIME**: SMTP, Gmail `messages.send` (`raw` + `threadId`), SES `SendRawEmail`. June builds
  the MIME once, including its own `Message-ID` and threading headers.
- **structured**: Cloudflare `env.EMAIL.send({...})` and REST, Resend, Mailgun. The adapter maps
  `OutboundEmail` to the provider's fields and passes `In-Reply-To` / `References` as headers.

`ownMessageId` matters for threading: when June cannot choose the outbound `Message-ID`, a
reply's `In-Reply-To` cannot be matched to a session by lookup alone, and the signed reply
address (§6) carries the routing instead.

### Cloudflare Email Service (read 2026-09-28)

The first provider, and the one June's edge target runs on. From the docs:

- **Inbound** arrives at the Worker's `email(message, env, ctx)` as a `ForwardableEmailMessage`:
  envelope `from` / `to`, `headers`, `raw` (a MIME stream), `rawSize`. Up to 25 MiB; unlimited
  and free on both Workers plans. The docs recommend `postal-mime` for parsing.
- **Addresses** can be declared in wrangler config (`addresses: ["scout@example.com",
  "*@example.com"]`, Wrangler ≥ 4.113.0), each routed to the Worker. A catch-all is apex-only;
  on a subdomain every address is listed literally — `june build` can emit the list from the
  agents' definitions. Limit: 200 routing rules per domain.
- **Subaddressing** (`scout+detail@…` matched by the `scout@…` rule, `+detail` preserved in
  `message.to`) is an account setting that must be turned on. The signed reply address
  (§6) depends on it; `diagnose()` must check it.
- **`message.reply()` is not the reply path.** It may be called once, inside the `email()`
  event, only to the original sender, and requires a valid DMARC result. An agent's reply is
  produced by a turn that runs after the event returns and may wait for approval, so replies go
  through the send binding like any other outbound mail.
- **Outbound** `env.EMAIL.send({ to, from, subject, html, text, cc, bcc, replyTo, attachments,
  headers })` returns `{ messageId }`; errors carry a `code` (`E_SENDER_NOT_VERIFIED`,
  `E_RATE_LIMIT_EXCEEDED`, …). Limits: 50 recipients, 5 MiB total (25 MiB to verified
  destinations), 16 KB of custom headers. Also available as REST
  (`/accounts/{id}/email/sending/send`) and SMTP (`smtp.mx.cloudflare.net:465`, the native
  host's path).
- **Headers are allowlisted.** `In-Reply-To`, `References`, `Auto-Submitted`, `List-*` and any
  `X-*` are settable; **`Message-ID` is platform-controlled** and cannot be set. A disallowed
  header rejects the whole send. So `ownMessageId: false` for Cloudflare, and threading replies
  to the agent rely on the signed reply address.
- **Sender restriction at the platform**: a `send_email` binding can set
  `allowed_sender_addresses`. `june build` emits one binding per agent restricted to that
  agent's address — the platform enforces that an agent can only send as itself.
- **Delivery events** (`message.delivered | deferred | bounced | failed | rejected |
  complained`) are published through Queues event subscriptions, per sending domain. June
  consumes them in a `queue()` entry and writes delivery status into the store; a bounce or
  complaint on a thread can wake its session.
- **Suppressions** are automatic: complaints (no expiry), hard bounces (7 days or permanent),
  soft bounces (24 h). Suppressed sends are rejected at the API and not billed. June surfaces
  the rejection to the agent rather than retrying.
- **Plans and cost**: sending to arbitrary recipients needs Workers Paid — 3,000 emails per
  month included, then $0.35 per 1,000. Before a sending domain is onboarded, only verified
  destination addresses are reachable (free, not counted).
- **Local dev**: `wrangler dev` simulates `email()` and the send binding; `ArrayBuffer`
  attachments cannot be serialized by the local simulator.

### Other providers

| provider | notes |
| --- | --- |
| Gmail | The agent's own Workspace account. OAuth or domain-wide delegation, resolved per call like `google-drive.ts`. `watch` renewal needs the alarm (§3.3). Gmail's `threadId` is carried as the thread key. |
| SES | SigV4 over Web Crypto (no `aws-sdk`). SNS message signature verification and `SubscriptionConfirmation` handling live in the adapter. |
| Resend | Svix-signed webhooks. Resend retains inbound mail when the webhook is down, so a notify cursor can recover. |
| Mailgun | Webhook signature: HMAC-SHA256 of `timestamp + token` with the signing key, plus the ±5 min freshness guard already in `channels.ts`. |
| SMTP | Native: `node:net` / `node:tls`. Edge: `cloudflare:sockets` `connect()` + `startTls()`; port 25 is blocked, use 587 / 465. |
| IMAP | The agent's own account. `IDLE` needs a long-lived connection, which the edge request model does not offer: native first (IDLE), edge by alarm polling. |
| POP3 | No flags, no folders, no stable threading. **Deferred** until someone needs it. |

## 6. The envelope, threading and reply routing

Extend `InboundEvent` with an optional `email` field:

```ts
email?: {
  mailbox: string;                 // the agent address this was delivered to
  messageId: string;
  from: { address: string; name?: string };
  to: string[]; cc: string[];
  subject: string;
  inReplyTo?: string; references: string[];
  auth: { dkim: "pass" | "fail" | "none"; spf: ...; dmarc: ... }; // from Authentication-Results
  autoSubmitted: boolean;          // RFC 3834 / bulk / list / bounce — see §7
  attachments: { key: string; filename: string; contentType: string; size: number }[];
};
```

**Thread key** — the session id — is resolved in this order:

1. **Signed reply address.** Every message the agent sends carries
   `Reply-To: <local>+<thread>.<mac>@<domain>`, where `mac` is an HMAC over
   `(agent, thread)`. A reply to it names its thread directly, even when the client dropped
   `References`, and even on providers where June cannot choose its own `Message-ID`
   (Cloudflare). A bad MAC is ignored, never trusted.
2. **Provider thread id** (Gmail `threadId`).
3. **Header lookup**: `In-Reply-To` / `References` matched against `Message-ID`s in the store.
4. **Otherwise a new thread.** Never subject matching.

**Model input**: HTML is converted to markdown, quoted history is stripped (the session already
has it), and attachments stay in `blob` — the model sees their metadata and reads content
through a `read_attachment` tool.

## 7. Safety

Email is reachable by anyone, so these are defaults, not options:

1. **Identity.** Correspondents are anonymous. A `principal` is set only when DMARC (or aligned
   DKIM) passes **and** an app resolver maps the sender to one of the app's own principals (an
   operator writing to their agent). Every `requiresPrincipal` tool stays hidden otherwise.
2. **Prompt injection.** Message content is data. Because sending is gated, an injected
   "forward all invoices to x@evil" produces at worst a draft a human rejects.
3. **Send policy — the operator grants autonomy**, per recipient pattern:
   `draft` (never send) · `approve` (park on `requestInput`, **the default**) · `auto`
   (send without asking). `auto` is typically granted for replies within an existing thread to
   known correspondents, never for new recipients by default. The approval prompt is delivered
   to another channel (Slack, the web UI) with `deliver()` — an email thread cannot render
   Approve / Deny.
4. **Loops.** Never reply to a message with `Auto-Submitted` other than `no`,
   `Precedence: bulk|list|junk`, a `List-Id`, a null return path, `MAILER-DAEMON`, or another
   agent address of the same app. Every outbound message a turn wrote carries
   `Auto-Submitted: auto-replied` (or `auto-generated` for proactive mail). Per-thread and
   per-correspondent rate limits back this up.
5. **Idempotency.** Dedupe on `Message-ID` per mailbox — every push and notify provider retries
   (the same shape as Slack's `event_id` dedupe, #170).
6. **Deliverability.** `email.diagnose()`, mirroring `SlackDiagnosis`: SPF, DKIM, DMARC for the
   sending domain, provider auth, subaddressing enabled (Cloudflare), suppression hits, and
   per-isolate counters (received, rejected by kind, deduped, loop-suppressed, bounced).

## 8. The mailbox store

Messages are rows in the app's `db` resource, owned by `@junejs/email` and shipped as plain-SQL
migrations the app can read; raw MIME and attachments are objects in `blob`.

```
email_messages   (id, agent, thread, direction, message_id, provider_id, from, to, cc,
                  subject, sent_at, status, auth, auto_submitted, blob_key)
email_threads    (agent, thread, subject, correspondents, last_at, session)
email_cursors    (agent, provider, cursor)
```

The per-thread session holds the conversation the model reasons over; the store holds the
mailbox the agent searches. Delivery events update `email_messages.status`. Full-text search
uses what the `db` backend offers (SQLite FTS5 on D1 and native SQLite; `tsvector` on Postgres).

## 9. Package layout and API sketch

```
packages/email/
  src/index.ts          # emailChannel, mail tools, types
  src/mime.ts           # parse (postal-mime) + build; threading headers
  src/thread.ts         # thread key resolution, signed reply address
  src/store.ts          # mailbox store + migrations
  src/safety.ts         # auto-submitted detection, rate limits, auth-results parsing
  src/providers/cloudflare.ts  gmail.ts  ses.ts  resend.ts  mailgun.ts
  src/providers/smtp.ts  imap.ts        # socket protocols, runtime-specific
```

Subpath exports (`@junejs/email/ses`, …) keep SigV4 and the IMAP client out of apps that do not
use them, and keep `channels.ts` (already 1906 lines) from growing.

```ts
// agent/agent.ts — the address is part of who the agent is
export default {
  name: "scout",
  model: "claude-opus-5-5",
  email: { address: "scout@agents.example.com" },
};

// agent/channels/email.ts — the transport and the policy (a factory: secrets live in env)
import { emailChannel } from "@junejs/email";
import { cloudflareEmail } from "@junejs/email/cloudflare";

export default (env: Env) => emailChannel({
  provider: cloudflareEmail({ send: env.EMAIL_SCOUT }),
  replySigningKey: env.EMAIL_REPLY_KEY,
  policy: {
    default: "approve",
    auto: [{ to: "*@example.com", inThread: true }],
    approvals: { via: "slack", target: { channelId: "C0123" } },
  },
});
```

From the address, `june build` emits the wrangler `addresses` entry and a `send_email` binding
restricted to the agent's address; the agent gets `email__search`, `email__list_threads`,
`email__read_thread`, `email__read_attachment`, `email__draft` and `email__send`.

## 10. Phasing

| phase | scope | proves |
| --- | --- | --- |
| **P0** | types, MIME parse/build, thread key, signed reply address, safety (§7.4–7.5), mailbox store + migrations, `.eml` corpus (multipart, non-UTF-8, encoded headers, auto-replies, bounces, list mail) | the provider-independent core |
| **P1** | Cloudflare inbound + outbound; worker `email()` and `queue()` entries; `june build` emits `addresses` + per-agent `send_email`; wrangler pin ≥ 4.113 | the edge target end to end |
| **P2** | Resend, SES; Gmail with durable `alarm()` | notify inbound, cursors, SigV4, OAuth, renewal |
| **P3** | Mailgun, SMTP outbound | coverage; socket I/O on both runtimes |
| **P4** | IMAP (native IDLE, edge polling) | poll inbound |
| — | POP3 | deferred |

Each phase ships with fetch-stub unit tests and an opt-in live contract suite per provider, the
testing split the Slack channel already uses.

## 11. Resolved decisions

1. **June stores the mail** (2026-09-28). The agent owns its mailbox; a store is required, not
   optional, and search reads the store (§2.2, §8).
2. **One session per thread** (2026-09-28). The mailbox store is the agent-wide view (§2.3).

## 12. Open questions

1. **Approval surface when no other channel exists.** The June web UI only, or a signed
   approve link emailed to the operator?
2. **`InboundEvent.kind`.** Reuse `"message"` with the `email` field, or add `"email"`?
3. **Address provisioning.** One domain per app with an address per agent, or let an agent own
   several addresses (aliases)? Aliases complicate the per-agent `allowed_sender_addresses`
   binding but are common (`support@` and `billing@` answered by one agent).
4. **Proactive mail and consent.** An agent writing first to someone who never wrote to it is
   outbound marketing territory (CAN-SPAM, GDPR, CASL; `List-Unsubscribe` for bulk). Should
   proactive sends to new recipients require `approve` regardless of policy?
