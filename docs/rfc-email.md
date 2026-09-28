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
   gains an `email` block: one **identity address** (the `From:` of every thread the agent
   starts) and any number of **aliases** (receiving addresses, e.g. `support@` and `billing@`
   answered by one agent). The provider and send policy live in `agent/channels/email.ts`.
   Addresses are covered in §6.
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
5. **No web approval surface.** The session DO answers only `POST /turn`, `POST /resume`,
   `POST /reset` and `GET /transcript` (`agent-durable.ts`); a parked `requestInput` can be
   answered from Slack, or by code calling `/resume`, but no page lists pending approvals.
6. **Engine gaps behind approvals and take-over** (each filed):
   - a park is visible only inside its session — no cross-session pending index, no
     resolution announcement (#260);
   - `requestInput`'s answerer is one id defaulting to the trigger user, who on email is the
     external correspondent (#261);
   - nothing can be added to a session's history without running a turn, and there is no
     attributed third-party role (#262);
   - an inbound event against a suspended session is rejected, not queued (#263).
7. **The `june` CLI's verbs are hard-coded** (`packages/cli/src/cli.ts`); a package cannot add
   `june inbox` (resolved by external subcommands, §9.3).
8. **`june deploy` pins `wrangler@4.99.0`** (`packages/june/src/deploy.ts`). Declaring inbound
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
- **Transactional only.** The FAQ: "Email Service is intended only for transactional emails";
  marketing and bulk tooling are planned, not offered. On Cloudflare, the R4 (cold) tier is
  unavailable — `allowCold` is a configuration error — and R3 (app-vouched) is documented as
  transactional relationships only (§7.3).
- **Reputation targets** (deliverability docs): delivery rate > 95%, hard-bounce rate < 2%,
  complaint rate < 0.1%. Cloudflare also recommends a separate (sub)domain per kind of mail.
- **No published daily quota and no quota API.** New accounts start conservatively and rise
  with reputation; the REST API covers send, send-raw, suppressions and sending subdomains,
  nothing that reads a quota. The adapter learns limits from `E_RATE_LIMIT_EXCEEDED` /
  `E_DAILY_LIMIT_EXCEEDED`: sends queue and back off, and `diagnose()` reports the last hit.
- **Retries are Cloudflare's.** Hard bounces are never retried; soft bounces are retried with
  exponential backoff by Cloudflare. June does not retry soft bounces itself.
- **Suppressed recipients fail the whole send** while the per-domain "Drop suppressed
  recipients" setting is off (the default): one suppressed address raises
  `E_RECIPIENT_SUPPRESSED` for the message. June keeps the default and checks suppression
  before drafting (§7.8).
- **Other send limits**: at most 32 attachments and 20 allowlisted (non-`X-`) custom headers
  per message.
- **Inbound gates before the Worker**: mail failing both SPF and DKIM is rejected, mail failing
  DMARC is rejected per the sender's policy, and senders on realtime block lists are rejected
  at SMTP. Whatever reaches `email()` passed at least one of SPF or DKIM — not necessarily
  aligned with `From:`, which is what §7.1 needs.
- **ASCII local parts only.** Email Routing supports internationalized domains but not
  internationalized local parts; agent addresses are validated at configuration time.
- **REST `send_raw`** takes a full RFC 5322 message plus the envelope. Whether it keeps a
  caller-set `Message-ID` is undocumented (the header allowlist says `Message-ID` is
  platform-controlled); it is on the live-test list (§13).

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

### Event kinds

`InboundEvent.kind` says **what happened** (a message, a reaction, an edit, a rating, a state
change); `source` says **which platform** it came from. `"message"` is already shared by Slack
and Crisp. So email does not get a kind of its own:

- **A new inbound mail is `kind: "message"`**, `source: "email"`, with the details in an
  `email` field — the same pattern as `rating?` and `state?`. Code that means "someone said
  something" (`replaceInFlight` debouncing, analytics by kind) keeps working unchanged, and
  per-channel behavior already keys on `source` (`channelInstructions[event.source]`).
- **Delivery status is a new, platform-neutral `kind: "delivery"`** with
  `delivery: { status: "delivered" | "deferred" | "bounced" | "failed" | "rejected" |
  "complained"; recipient; messageId; reason? }`. It is not a message; SMS or WhatsApp
  channels can reuse it later.
- **Auto-replies and out-of-office mail stay `"message"`** with `email.autoSubmitted: true`;
  the channel drops or only observes them (§7.4).
- **To vs Cc is a field, not a kind.** It resembles Slack's `app_mention` vs `message`, but
  mapping To onto `app_mention` would leak a Slack concept. `email.addressedAs` carries it and
  `respondWhen` decides (e.g. answer when in To, only observe when in Cc).

The email channel's `respondTo` / `on[kind]` accept `"message" | "delivery"`; the default is
`respondTo: ["message"]`, with `on.delivery` writing status to the store and waking a thread's
session only on a bounce or complaint.

### The envelope

Extend `InboundEvent` with an optional `email` field:

```ts
email?: {
  mailbox: string;                 // the agent address (identity or alias) it was delivered to
  addressedAs: "to" | "cc" | "bcc";
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

### Addresses and aliases

- **Reply from the address that was written to.** A mail to `billing@` is answered from
  `billing@`; the thread records its address (`email_threads.mailbox`). The model sees it
  (`event.email.mailbox`), so `instructions.email.md` can vary behavior per address.
- **The platform restriction is per agent, not per address.** The agent's `send_email`
  binding sets `allowed_sender_addresses` to its identity address plus its aliases: it can use
  any of its own addresses and none of another agent's.
- **One address, one agent.** Several agents behind one address turns into "who answers?";
  that is a routing agent that hands off, not a shared address.
- **Dynamic addresses** (a tenant per address) go through an app-level `route(to) => agent`
  in `june.config.ts` behind an apex catch-all. On Cloudflare a catch-all is apex-only and a
  domain holds at most 200 rules, so per-tenant rules do not scale.
- **`+` is reserved** for June's signed reply address; tenants are distinguished by the local
  part or by `route`, never by a subaddress.
- **A dedicated sending subdomain** (`agents.example.com`) keeps an agent's mistakes from
  costing the company domain its reputation; `diagnose()` recommends it.
- **Renaming is safe.** The reply signature covers the agent id, not the address; keep the old
  address as an alias and existing threads still route.

### Model input

HTML is converted to markdown, quoted history is stripped (the session already
has it), and attachments stay in `blob` — the model sees their metadata and reads content
through a `read_attachment` tool.

## 7. Safety

Email is reachable by anyone, so these are defaults, not options:

1. **Identity.** Correspondents are anonymous. A `principal` is set only when DMARC (or aligned
   DKIM) passes **and** an app resolver maps the sender to one of the app's own principals (an
   operator writing to their agent). Every `requiresPrincipal` tool stays hidden otherwise.
2. **Prompt injection.** Message content is data. Because sending is gated, an injected
   "forward all invoices to x@evil" produces at worst a draft a human rejects.
3. **Send policy — the operator grants autonomy.** Each send is `draft` (never sent),
   `approve` (park on `requestInput`, **the default**) or `auto` (sent without asking), decided
   by the agent's **relationship to the recipient** — facts June can check — never by what the
   message is about (whether a mail is "transactional" or "commercial" is a legal
   classification a model must not be trusted to make):

   | tier | relationship | default | may be `auto`? |
   | --- | --- | --- | --- |
   | **R1** | reply in a thread the correspondent started | approve | yes |
   | **R2** | new thread to someone who has written to this agent before | approve | yes |
   | **R3** | a recipient the app vouches for — `consent(recipient)` hook (a CRM consent flag, an internal domain) | approve | yes; the app answers for it |
   | **R4** | anyone else (cold) | approve | only with an explicit `allowCold`, always under the §7.8 caps; **never on Cloudflare** (transactional only, §5) |

   Approvals are answered through the operator surface (§9) and, optionally, another channel (Slack)
   through `deliver()` — an email thread cannot render Approve / Deny.
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
7. **Limits have two sources, kept apart.**
   - *Provider capacity* is an external fact June must never exceed. Per-message limits are
     declared by each adapter (Cloudflare: 50 recipients, 5 MiB, 32 attachments; Gmail API:
     500 recipients). Account quotas vary per account and are read at run time where an API
     exists (SES `GetAccount`), configured or learned from limit errors otherwise. Verified
     2026-09-28: SES sandbox 200 messages / 24 h at 1 / s, production set case by case; Resend
     Free 100 / day (UTC day), 10 API requests / s per team; Workspace 2,000 messages and 2,000
     unique external recipients per user per day; Mailgun Free 100 / day and 1 custom domain,
     Basic 10,000 / month with no daily cap; Cloudflare unpublished (§5).
   - *June's safety policy* is provider-independent: new recipients per agent per day (default
     20) and a circuit breaker set **below** the strictest external enforcement. The external
     numbers (verified 2026-09-28): Cloudflare targets hard bounces < 2% and complaints < 0.1%;
     SES puts an account under review at 5% bounces or 0.1% complaints and may pause it at 10%
     or 0.5%, measured over a "representative volume" rather than a fixed window; Gmail
     requires a spam rate below 0.3% for all senders and recommends below 0.1%, and treats
     more than 5,000 messages a day to Gmail accounts as bulk (SPF + DKIM + DMARC and one-click
     unsubscribe required).
   - *Proposed breaker defaults*: trip at a 0.08% complaint rate or a 1.5% hard-bounce rate;
     warn when the delivery rate drops below 95%. Rates are computed over a rolling window
     only once it holds at least 200 sends; below that, absolute counts rule — two complaints
     in 30 days, or any complaint on proactive (R3 / R4) mail, trips it. Tripping drops every
     tier to `approve` and notifies the operator.
   - The effective limit is `min(provider capacity, account quota, June default, app config)`;
     over it, sends queue instead of failing. Policy numbers live in code
     (`agent/channels/email.ts`, reviewed and versioned); deploy-time environment overrides may
     only **tighten** them. A new sending domain warms up: limits start lower and rise over its
     first weeks.
8. **Proactive mail.** An agent writing first is where legal exposure (CAN-SPAM in the US,
   CASL in Canada, ePrivacy/GDPR in the EU) and reputation damage (Gmail and Yahoo bulk-sender
   rules) concentrate. The framework enforces mechanisms; the app remains responsible for
   compliance, and none of this is legal advice. Apps can tune the numbers, not remove the
   mechanisms:
   - **Caps**: a daily limit on new recipients per agent; a proactive new thread has exactly
     one recipient; the agent cannot Bcc.
   - **Unsubscribe**: every proactive message carries `List-Unsubscribe` (+ one-click
     `List-Unsubscribe-Post`) pointing at an endpoint June generates; an unsubscribe — one
     click or a reply asking for it — suppresses the recipient in June's store and, on
     Cloudflare, as a manual suppression.
   - **Checked before drafting**: the send and draft tools refuse a suppressed recipient and
     tell the model why, so the agent stops instead of failing at send time.
   - **Circuit breaker**: when an agent's bounce or complaint rate crosses a threshold, every
     tier drops to `approve` and the operator is notified.
   - **Sender identification**: slots for organization name and postal address, appended to
     proactive mail (CAN-SPAM requires them on commercial mail).
   - **AI disclosure, on by default**: a signature line stating the mail was written by an AI
     agent. Transparency obligations for AI systems that interact with people (e.g. the EU AI
     Act, Article 50) should be confirmed by the app's counsel.

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

## 9. The operator surface — contract first, GUI last

The default `approve` policy is unusable without a place to approve, and Slack is optional, so
June ships its own way to supervise an agent's mailbox. It is not a mail client for a human's
inbox (agentic-inbox's shape): the mailbox is the agent's, and the operator's first question is
what is waiting on them, not what is new.

It is built in layers, each one usable on its own before the next exists:

```
data contract  →  API  →  CLI & TUI  →  web GUI
```

Contract first, because June's premise is one definition serving every surface: a CLI, a TUI,
a GUI and an agent built on the same contract cannot drift. CLI next, because it is the
cheapest complete surface, scriptable, testable, and usable by coding agents (Claude Code
supervising a June agent through `june inbox --json`). The GUI comes last: it is the most
expensive and most opinionated layer, and by then it only renders what the lower layers
already do.

### 9.1 Data contract

Versioned, JSON-Schema-described types — the contract, not the tables (§8 implements it):

- `Mailbox` — agent, identity address, aliases, policy summary.
- `Thread` — id, mailbox, subject, correspondents, **state** (`active`, `waiting_on_correspondent`,
  `waiting_on_operator`, `taken_over`, `bounced`, `closed`), last activity.
- `Message` — direction, headers that matter, body as markdown, attachments (metadata),
  delivery status.
- `PendingAction` — a parked input: what the agent wants to do (the draft, its recipients and
  relationship tier §7.3), why (the turn it came from), and its answer shape. **Not
  email-specific**: a Slack HITL prompt is the same record with a different `source`.
- `TurnTrace` — a turn's steps (tool calls, results, reasoning summary), folded from the
  `TurnEvent` log. Also not email-specific.
- `Decision` — approve, approve-with-edits, reject-with-note, take over, hand back; who and
  when.
- `InboxEvent` — the change feed: mail received, pending action created or resolved, delivery
  status changed, thread state changed.

`PendingAction`, `TurnTrace` and `Decision` form a generic **agent supervision contract**
shared by every channel; `Mailbox`, `Thread` and `Message` are the email layer on top.

Where it lives is split by what only the engine can do:

- **`@junejs/core`** gets the minimal engine seams: park and resolution announcements (#260),
  answerer policies (#261), attributed notes (#262), queued inbound while suspended (#263).
  Slack needs every one of them too.
- **`@junejs/core/supervise`** (a subpath) holds the contract's types and JSON Schema —
  types only, which keeps core pure.
- **`@junejs/server`** implements it: the `pending_actions` index, the supervision actions and
  the change feed. It is host code, and the server already hosts the agent DO and `/mcp`; it
  mounts whenever the app has an agent, so approvals work without installing anything.
- **`@junejs/email`** adds the mailbox layer: channel, providers, store, the email actions.
- **`@junejs/inbox`** is the operator client — CLI and TUI, bin `june-inbox` — and nothing
  else. It speaks only HTTP to the API, so it needs no app code (§9.3).

The name follows the house style of short nouns (`db`, `og`, `i18n`, `juno`) and matches the
verb, and "inbox" as "what is waiting on you" is the sense GitHub and Linear already taught.
Rejected: `supervise` (a verb), `console` (implies the GUI that comes last), `ops` (DevOps),
`operator` (Kubernetes).

### 9.2 API

Every operation is a `defineAction`, so the API needs no separate implementation: each action
is at once an agent tool, an `/mcp` tool and a UI server action, and the principal comes from
the same seam as everywhere else (a session, or a bearer API key for the CLI —
`docs/auth-integration.md`).

- Reads: `list_mailboxes`, `list_threads(filter)`, `get_thread` (messages + traces),
  `list_pending(filter)`, `diagnose`.
- Decisions: `approve(pending, edits?)` — resumes the thread's session with
  `resumeDelivered` — `reject(pending, note)`, `take_over(thread)`, `hand_back(thread)`.
- Initiative: `compose` (the operator writes as the agent's address), `instruct` (a
  proactive turn: "write to X about Y").
- A change feed: `InboxEvent`s over SSE, resumable from a cursor, so a TUI or GUI stays live
  without polling.
- Authorization per mailbox: an `authorize(principal, agent)` hook filters every read and
  guards every decision — never one policy that opens every mailbox.

**CLI credentials.** June is auth-agnostic: the app's `identity(request)` seam turns a request
into a principal (`pipeline.ts`), Better Auth being the recommended implementation. So the
CLI's only contract is `Authorization: Bearer <token>`; how the token is obtained:

1. `june login <app-url>` (provided by `@junejs/inbox`) uses the OAuth device authorization grant (RFC 8628) when the app
   advertises it in its discovery document — it works over SSH and with no local browser, and
   Better Auth ships a plugin for it. Otherwise it falls back to pasting a token
   (`june login --token`). The device-code page is the one web page needed before the GUI
   phase, and it belongs to the app's auth pages anyway.
2. Tokens are stored in the OS keychain where available, else a `0600` file, keyed by app
   origin, with named profiles (`--app prod`).
3. `JUNE_TOKEN` overrides the stored token, for CI and coding agents.
4. `june dev` mints a short-lived local token into `.june/dev-token` (git-ignored); the CLI
   uses it against localhost.
5. Tokens are scoped and expiring — `inbox:read`, `inbox:decide`, `mail:send`, optionally per
   mailbox — so a coding agent can be given read and decide without send. No all-powerful
   static admin key by default.

### 9.3 CLI, TUI and distribution

**One verb.** `docs/cli.md` rule 4 is "keep the verb set tight", so there is no separate
`june mail`: email-specific subcommands live under `june inbox` and appear only when the app's
discovery document says email is enabled.

```
june inbox                                    # no subcommand: the TUI
june inbox login <app-url> [--token]          # also reachable as `june login`
june inbox pending [--agent scout] [--source email|slack] [--json]
june inbox approve <pending> [--edit]         # --edit opens the draft in $EDITOR
june inbox reject <pending> --note "…"
june inbox show <pending|session> [--trace]
june inbox watch                              # the change feed, line by line
# with email enabled:
june inbox threads [--agent scout] [--state waiting_on_operator] [--json]
june inbox take-over <thread> | hand-back <thread> [--note "…"]
june inbox send --agent scout --to … --subject …   # the operator writes as the agent
june inbox instruct --agent scout "write to … about …"
june inbox diagnose [--agent scout]
```

`--json` on every read makes the CLI a second machine interface next to `/mcp`.

**External subcommands.** `june <verb>` that is not built in runs `june-<verb>`, looked up in
the app's `node_modules/.bin`, then on `PATH` — the git / cargo model. Built-in verbs that need
the app's code (`gen`, `db`) stay built in; the CLI keeps a small table of first-party
external verbs for `help` and for an install hint, like the one it already prints for
`@junejs/i18n`. Alternatives considered: a hard-coded list lazily imported from the app's
dependencies (needs a CLI release per verb, works only inside a project), `package.json`
manifests discovered by scanning dependencies (runs third-party code in-process on every
invocation), plugins in `june.config.ts` (needs the project). External subcommands win on
four counts: only an explicitly invoked binary runs; the client versions and ships on its
own; it works for operators who do not have the app's repository; and it survives the
planned move of `june` to a native binary (`docs/cli.md`), because an exec boundary does not
care what either side is written in.

**The TUI** is a keyboard triage loop over the pending queue (next / previous, approve, edit
in `$EDITOR`, reject with a note, open the thread and its trace), kept live by the change
feed, built on **OpenTUI**'s React reconciler with Ink as the fallback; `@clack/prompts` covers
one-off confirmations. Checked 2026-09-28: `@opentui/core` 0.5.12 ships prebuilt native
packages for eight targets (macOS, Linux glibc and musl, Windows; x64 and arm64) — no Zig
toolchain; it needs `bun >= 1.3` or `node >= 26.4` and React ≥ 19.2; it installs 14 MB plus a
5.4 MB native package for the host; and `bun build --compile` of an OpenTUI program produced
a 74 MB darwin-arm64 binary that rendered and exited cleanly when copied to a directory with
no `node_modules`.

**Why the TUI is not in `@junejs/cli`.** Every June project would install OpenTUI's native
packages whether or not it has an agent to supervise; and the native `june` planned in
`docs/cli.md` runs on deno_core, which cannot load a library OpenTUI reaches through Bun's
FFI. A separate client behind an exec boundary has neither problem.

**Distribution of `@junejs/inbox`:**

1. `bunx @junejs/inbox …` or a global install;
2. a single-file binary per platform (`bun build --compile`), attached to releases, later
   `curl | sh`;
3. inside a project, `june inbox` delegating to it.

It is released with the monorepo (the publish workflow's tag equals `@junejs/core`'s version,
on the `dev` channel for now), with **OpenTUI pinned to an exact version** and bumped only by
its own changeset — 330 releases so far means it moves fast — behind a thin internal
component layer so a switch to Ink stays cheap, and a CI smoke test that compiles and runs the
TUI under a pseudo-terminal on macOS arm64 and Linux x64 / arm64.

**Contract versioning.** Because the client ships apart from the app, an operator's client
and an app's server will differ in version. The server's discovery document advertises the
supervision contract version and its capabilities (email or not); the client supports a range
and says so plainly when it is outside it. The contract's version is independent of package
versions; a breaking contract change bumps its major.

### 9.4 Web GUI

Last, and thin: pages over the same API, generated into `.june/routes/` — the convention
slot for framework-generated routes (`route-scan.ts`; kura writes its docs routes there).
`app/` wins per path, so an app replaces one page without forking the rest. Zero client JS by
default; islands for the draft editor and composer; `client-live` for the change feed. Every
page also answers `.md` / `.json`, like every June page.

| page | shows |
| --- | --- |
| **Needs you** | the pending queue |
| **Threads** | threads by state |
| **Thread** | mail interleaved with the agent's turn traces; take over / hand back |
| **Compose** | write directly, or instruct the agent |
| **Settings** | addresses, policy, `instructions.email.md`, `diagnose()` |

### 9.5 One approval, several surfaces

The parked checkpoint in the session is the single source of truth; the engine already
answers a second resume with 409. On top of it:

1. **Index.** Park and resolution announcements (#260) maintain `pending_actions`, which every
   surface lists from.
2. **Surface registry.** Every rendering of a pending action records its handle
   (`pending_surfaces`: a Slack channel + message ts, a GUI session). On resolution, a
   `pending.resolved` event updates each one — the Slack message becomes "Approved by Alice
   via CLI at …" and loses its buttons; CLI, TUI and GUI follow the change feed.
3. **Races.** Concurrent answers are serialized by the session; the loser gets 409 and its
   surface says who resolved it, not a generic error.
4. **Revisions.** A decision carries the draft `revision` it was made against; approving a
   revision the agent has since replaced is refused, so no one approves text they did not see.
5. **Answerers.** Who may answer is a policy (#261) — for email, the mailbox's operators via
   `authorize(principal, agent)`; never the correspondent.
6. **Mail during a park.** Inbound mail is stored and its turn queued (#263); the pending
   action is marked "new mail since this draft", and approving it asks for confirmation.
7. **Staleness.** A pending action reminds its approvers after a while and is marked stale
   later. It is never auto-sent and never auto-discarded.

### 9.6 Take-over and hand-back

A thread's control is a small state machine:

```
agent ──take_over──▶ taken_over(by) ──hand_back(note?)──▶ agent
  ▲                                                        │
  └──────── escalate(reason): the agent asks a person ─────┘
```

- **Take over** resolves any pending action on the thread as superseded (the session never
  stays parked), stops turns on the thread, and makes the agent's send tools refuse it.
  Inbound mail keeps being stored.
- **The operator writes from the agent's address**, so the correspondent sees one
  conversation, with the operator's own signature and **without** the AI-disclosure line —
  a person wrote it.
- **The agent's history records it as an attributed note (#262)**, never as `assistant`:
  "[operator Alice replied at …, not you]: …". Otherwise the model believes it wrote the
  operator's words and may imitate them or stand by commitments it never made.
- **Hand-back is explicit by default.** A take-over usually means a sensitive situation, so
  idleness only prompts ("idle for 3 days — hand back?"); automatic hand-back is opt-in.
  A hand-back note ("take it from here; offer the refund") starts a proactive turn; without a
  note or unanswered inbound mail, the agent does nothing.
- **`escalate(reason)`** is the agent's side: it sets `waiting_on_operator` and the thread
  appears in `june inbox`.

## 10. Package layout and API sketch

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

```
packages/inbox/        # @junejs/inbox — operator client, bin `june-inbox`
  src/cli.ts           # subcommands, --json
  src/tui/             # OpenTUI views behind a thin component layer
  src/credentials.ts   # june login: device flow, token paste, keychain / 0600 file
```

Subpath exports (`@junejs/email/ses`, …) keep SigV4 and the IMAP client out of apps that do not
use them, and keep `channels.ts` (already 1906 lines) from growing.

```ts
// agent/agent.ts — the address is part of who the agent is
export default {
  name: "scout",
  model: "claude-opus-5-5",
  email: {
    address: "scout@agents.example.com",                      // identity: From of new threads
    aliases: ["support@example.com", "billing@example.com"],  // receiving addresses
  },
};

// agent/channels/email.ts — the transport and the policy (a factory: secrets live in env)
import { emailChannel } from "@junejs/email";
import { cloudflareEmail } from "@junejs/email/cloudflare";

export default (env: Env) => emailChannel({
  provider: cloudflareEmail({ send: env.EMAIL_SCOUT }),
  replySigningKey: env.EMAIL_REPLY_KEY,
  policy: {
    reply: "auto",          // R1
    known: "approve",       // R2
    vouched: "approve",     // R3, with consent below
    cold: "approve",        // R4; "auto" additionally requires allowCold
    consent: (recipient) => crm.hasConsent(recipient),
    limits: { newRecipientsPerDay: 20 },
    approvals: { mirror: { via: "slack", target: { channelId: "C0123" } } }, // the operator surface always has them
  },
});
```

From the addresses, `june build` emits the wrangler `addresses` entries and a `send_email`
binding restricted to the agent's own addresses; `june inbox` and, later, the web pages
in `.june/routes/` operate it through the same actions; the agent gets `email__search`, `email__list_threads`,
`email__read_thread`, `email__read_attachment`, `email__draft` and `email__send`.

## 11. Phasing

| phase | scope | proves |
| --- | --- | --- |
| **P0e** | engine seams: #260, #261, #262, #263; CLI external subcommands | approvals and take-over have something to stand on |
| **P0** | types, MIME parse/build, thread key, signed reply address, safety (§7.4–7.5, §7.8 caps and suppression), mailbox store + migrations, `.eml` corpus (multipart, non-UTF-8, encoded headers, auto-replies, bounces, list mail) | the provider-independent core |
| **P1** | the Cloudflare live tests (§13) first; Cloudflare inbound + outbound; worker `email()` and `queue()` entries; `june build` emits `addresses` + per-agent `send_email`; wrangler pin ≥ 4.113 | the edge target end to end |
| **P1b** | supervision contract + API (§9.1–9.2), `@junejs/inbox` CLI + `june login`, per-mailbox `authorize` | `approve` works without Slack, from a terminal or a coding agent |
| **P1c** | `june inbox` TUI, the change feed, compiled binaries | live triage; operators without the repo |
| **P2** | Resend, SES; Gmail with durable `alarm()` | notify inbound, cursors, SigV4, OAuth, renewal |
| **P3** | Mailgun, SMTP outbound | coverage; socket I/O on both runtimes |
| **P4** | IMAP (native IDLE, edge polling) | poll inbound |
| **P5** | web GUI in `.june/routes/` (§9.4) | the last, thinnest layer |
| — | POP3 | deferred |

Each phase ships with fetch-stub unit tests and an opt-in live contract suite per provider, the
testing split the Slack channel already uses.

## 12. Resolved decisions

1. **June stores the mail** (2026-09-28). The agent owns its mailbox; a store is required, not
   optional, and search reads the store (§2.2, §8).
2. **One session per thread** (2026-09-28). The mailbox store is the agent-wide view (§2.3).
3. **June ships its own operator surface, contract first** (2026-09-28): data contract → API →
   CLI & TUI → web GUI, in that order; other channels (Slack) are optional mirrors (§9).
4. **Email reuses `kind: "message"`**; delivery status is a new, platform-neutral
   `kind: "delivery"` (2026-09-28, §6).
5. **An agent has one identity address and any number of aliases**; it replies from the
   address that was written to (2026-09-28, §6).
6. **Proactive sends are tiered by relationship**, with caps, unsubscribe, suppression, a
   circuit breaker and AI disclosure enforced by the framework (2026-09-28, §7.3, §7.8).

7. **Packages** (2026-09-28, §9.1): engine seams in `@junejs/core`, contract types in
   `@junejs/core/supervise`, the implementation in `@junejs/server`, the mailbox in
   `@junejs/email`, the operator client in `@junejs/inbox`. One verb, `june inbox`; no
   `june mail`.
8. **TUI on OpenTUI (React), pinned, Ink as fallback; the client ships separately from
   `@junejs/cli` as an external subcommand, as a package and as compiled binaries, over a
   versioned contract** (2026-09-28, §9.3).
9. **CLI credentials: bearer tokens via `june login` (device flow, token-paste fallback),
   keychain storage, `JUNE_TOKEN` override, scoped and expiring** (2026-09-28, §9.2).
10. **Approvals across surfaces: index, surface registry, revisions, answerer policies, queued
    mail** (2026-09-28, §9.5).
11. **Limits: provider capacity and June policy kept apart; code sets policy, deploy config
    may only tighten it** (2026-09-28, §7.7).
12. **Take-over: explicit hand-back, attributed notes, no AI disclosure on human-written
    mail** (2026-09-28, §9.6).
13. **Cloudflare is transactional only**: no R4 on Cloudflare, R3 documented as transactional
    (2026-09-28, §5, §7.3).
14. **Verified provider numbers and proposed breaker defaults** recorded in §7.7
    (2026-09-28).

## 13. Open questions and live tests

Cloudflare is built first, and five of its behaviors are undocumented or account-specific;
each is settled by a test against a real onboarded domain before P1 code depends on it:

1. **Does the message `email()` receives carry `Authentication-Results`?** §7.1 derives an
   operator's identity from aligned DMARC / DKIM. If the header is absent, June verifies DKIM
   itself over the raw MIME (DNS-over-HTTPS for the key, Web Crypto for the signature).
2. **Does REST `send_raw` keep a caller-set `Message-ID`?** If it does, header lookup (§6)
   becomes a reliable second thread key on Cloudflare.
3. **Is a delivery event's `messageId` the one `send()` returned?** It decides how delivery
   status is joined to stored messages.
4. **Do subaddressing and wrangler `addresses` work together** (`scout+<thread>.<mac>@…`
   reaching the Worker through a literal `scout@…` rule on a subdomain)?
5. **What daily quota does the account actually start with?**

Also open: the circuit breaker's defaults (§7.7) are a proposal to be tuned against real
traffic.
