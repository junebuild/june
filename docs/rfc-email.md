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
6. **`june deploy` pins `wrangler@4.99.0`** (`packages/june/src/deploy.ts`). Declaring inbound
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
   | **R4** | anyone else (cold) | approve | only with an explicit `allowCold`, always under the §7.7 caps |

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
7. **Proactive mail.** An agent writing first is where legal exposure (CAN-SPAM in the US,
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

### 9.3 CLI and TUI

The `june` CLI already has nested verbs (`june db migrate`); the inbox is `june inbox`,
talking to a running or deployed app through the API:

```
june inbox pending [--agent scout] [--json]
june inbox approve <pending> [--edit]        # --edit opens the draft in $EDITOR
june inbox reject <pending> --note "…"
june inbox threads [--agent scout] [--state waiting_on_operator] [--json]
june inbox show <thread> [--trace]
june inbox take-over <thread> | hand-back <thread>
june inbox send --agent scout --to … --subject …   # compose
june inbox instruct --agent scout "write to … about …"
june inbox watch                              # the change feed, line by line
june inbox diagnose [--agent scout]
```

`--json` on every read makes the CLI a second machine interface next to `/mcp`. `june inbox`
with no verb opens the **TUI**: a keyboard triage loop over the pending queue (next / previous,
approve, edit in `$EDITOR`, reject with a note, open the thread and its trace), kept live by
the change feed.

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
| **P0** | types, MIME parse/build, thread key, signed reply address, safety (§7.4–7.5, §7.7 caps and suppression), mailbox store + migrations, `.eml` corpus (multipart, non-UTF-8, encoded headers, auto-replies, bounces, list mail) | the provider-independent core |
| **P1** | Cloudflare inbound + outbound; worker `email()` and `queue()` entries; `june build` emits `addresses` + per-agent `send_email`; wrangler pin ≥ 4.113 | the edge target end to end |
| **P1b** | supervision contract + API (§9.1–9.2), `june inbox` CLI, per-mailbox `authorize` | `approve` works without Slack, from a terminal or a coding agent |
| **P1c** | `june inbox` TUI and the change feed | live triage |
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
   circuit breaker and AI disclosure enforced by the framework (2026-09-28, §7.3, §7.7).

## 13. Open questions

1. **Where the supervision contract lives.** `PendingAction` / `TurnTrace` / `Decision` are
   channel-neutral: `@junejs/core`, a new package, or `@junejs/email` until a second channel
   needs them?
2. **TUI toolkit on Bun**, and whether the TUI ships in the `june` CLI or a separate binary.
3. **CLI credentials.** How `june inbox` gets its bearer key per app and environment (a
   `june login`, an env var, the wrangler-style config file).
4. **One approval, several surfaces.** When the operator surface and a Slack mirror both show the same
   parked input, the engine already rejects the second answer — but the losing surface must
   update (the Slack message still shows its buttons). What notifies it?
5. **Default caps.** The starting value for new recipients per day, and the bounce and
   complaint thresholds that trip the circuit breaker.
6. **Take-over semantics.** While an operator holds a thread, inbound mail is stored but starts
   no turn. How does the thread go back to the agent — explicitly only, or also after a
   timeout — and does the agent's next turn see the operator's messages as its own?
