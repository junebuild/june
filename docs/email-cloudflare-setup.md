# Email on Cloudflare — a sending and receiving subdomain for your agents

> **Status: draft.** Written ahead of the `@junejs/email` Cloudflare provider (RFC:
> `docs/rfc-email.md`). Steps are taken from Cloudflare's Email Service docs, read
> 2026-09-28. Each step is marked **verified** with a date once it has been performed for
> real — June dogfoods this on `agents.june.build`. When the feature ships, this guide is a
> `sources:` entry for the site's email page.

## What you end up with

- A subdomain (here `agents.example.com`) that **receives** mail for your agents' addresses
  and routes it to your Worker's `email()` handler.
- The same subdomain onboarded for **sending**, so agents send as `support@agents.example.com`
  with SPF, DKIM and DMARC aligned.
- Delivery events (delivered, bounced, complained, …) arriving on a Queue.

Nothing here touches your apex domain's mail or website.

## Before you start

| requirement | why |
| --- | --- |
| The domain's DNS is on Cloudflare | Email Routing and Email Sending both manage DNS records for you. |
| **Workers Paid** | Sending to arbitrary recipients needs it (3,000 emails / month included, then $0.35 per 1,000). On any plan you can send, free, to *verified destination addresses* in your account — enough for testing. |
| **A subdomain, not the apex** | Cloudflare recommends a separate (sub)domain per kind of mail, so an agent's bounce or complaint rate cannot hurt the reputation of your main domain. |
| **ASCII local parts** | Email Routing supports internationalized domains but not internationalized local parts: `support@` works, `客服@` does not. |
| **Wrangler ≥ 4.113.0** | Needed to declare inbound addresses in wrangler config (`addresses`). |
| **Transactional mail only** | Cloudflare's FAQ: "Email Service is intended only for transactional emails." Replies and follow-ups on existing relationships are fine; cold outreach and marketing are not. |

## 1. Email Routing on the subdomain

Dashboard: **Compute → Email Service → Email Routing**, add `agents.example.com`.

Cloudflare adds, on the subdomain:

| record | value |
| --- | --- |
| `MX` | several `*.mx.cloudflare.net` hosts at different priorities |
| `TXT` (SPF) | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `TXT` (DKIM, routing) | `cf2024-1._domainkey.agents.example.com` |

A catch-all rule (`*@domain`) works on apex domains only; on a subdomain every address is
listed literally — `june build` emits the list from your agents' addresses.

Status: not yet verified.

## 2. Turn on subaddressing

Dashboard: **Email Routing → Settings → Subaddressing**. It is off by default.

With it on, `support+anything@agents.example.com` is matched by the `support@…` rule and the
`+anything` part is preserved in `message.to`. June's signed reply addresses depend on it.

Status: not yet verified.

## 3. Email Sending on the subdomain

Dashboard: **Compute → Email Service → Email Sending**, onboard `agents.example.com`.

Cloudflare adds:

| record | value |
| --- | --- |
| `TXT` (SPF) on `cf-bounce.agents.example.com` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `TXT` (DKIM, sending) | `cf-bounce._domainkey.agents.example.com` |

Leave **Drop suppressed recipients** off (the default): a suppressed recipient then fails the
send with `E_RECIPIENT_SUPPRESSED` instead of being silently dropped. June checks suppression
before drafting.

Status: not yet verified.

## 4. DMARC

Add a TXT record at `_dmarc.agents.example.com`, starting in monitor mode:

```txt
v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com
```

Move to `p=quarantine`, then `p=reject`, once the aggregate reports show only legitimate,
aligned mail. If `rua` points at another domain, that domain must publish a
`_report._dmarc` authorization record (RFC 7489 §7.1).

Status: not yet verified.

## 5. A verified destination address (for testing)

Dashboard: **Email Routing → Destination addresses**, add your own mailbox and confirm the
verification mail. Sends to verified destinations are free on every plan and do not count
toward quotas.

Status: not yet verified.

## 6. An API token for deploys

The token that deploys the Worker needs to edit Workers scripts and Email Routing rules
(`addresses` in wrangler config creates rules), and to use Email Sending; delivery events
additionally need Queues and event subscriptions. Record the exact permission names here
once the token has been created and a deploy has succeeded with it.

Status: not yet verified.

## 7. Wrangler configuration

`june build` will emit this from your agents' definitions; shown here so the moving parts are
visible:

```jsonc
{
  // inbound: each address becomes a routing rule to this Worker
  "addresses": ["support@agents.example.com", "hello@agents.example.com"],
  // outbound: one binding per agent, restricted to that agent's own addresses
  "send_email": [
    {
      "name": "EMAIL_SUPPORT",
      "allowed_sender_addresses": ["support@agents.example.com", "hello@agents.example.com"]
    }
  ]
}
```

Status: not yet verified.

## 8. Delivery events

Email Sending publishes `message.delivered | deferred | bounced | failed | rejected |
complained` through **Queues event subscriptions**, one subscription per sending domain. The
Worker consumes the queue in a `queue()` handler. Inbound (routing) activity is not published
as sending events.

Status: not yet verified.

## Check it

```sh
dig +short MX agents.example.com
dig +short TXT agents.example.com                      # routing SPF
dig +short TXT cf2024-1._domainkey.agents.example.com  # routing DKIM
dig +short TXT cf-bounce.agents.example.com            # sending SPF
dig +short TXT cf-bounce._domainkey.agents.example.com # sending DKIM
dig +short TXT _dmarc.agents.example.com
```

## Things that surprise people

- **`Message-ID` is Cloudflare's.** The send API rejects a caller-set `Message-ID`; threading
  replies back to the right conversation relies on June's signed reply address.
- **`message.reply()` is not how an agent replies.** It works once, inside the `email()`
  event, only to the original sender; an agent's reply comes from a turn that runs later.
- **No published daily quota.** New accounts start conservatively and rise with reputation;
  hitting it raises `E_DAILY_LIMIT_EXCEEDED`.
- **Cloudflare retries soft bounces itself** and never retries hard bounces.
- **Mail failing both SPF and DKIM never reaches your Worker**, nor does mail failing the
  sender's DMARC policy or coming from a block-listed IP.
- **Local dev** (`wrangler dev`) simulates `email()` and the send binding, but cannot
  serialize `ArrayBuffer` attachments.

## Sources

- Cloudflare Email Service docs: <https://developers.cloudflare.com/email-service/> — domain
  configuration, routing rules and addresses, send bindings, headers, limits, pricing,
  deliverability, postmaster, FAQ, event subscriptions (read 2026-09-28).
