# Email on Cloudflare — a sending and receiving subdomain for your agents

> **Status: draft.** Written ahead of the `@junejs/email` Cloudflare provider (RFC:
> `docs/rfc-email.md`). Steps are taken from Cloudflare's Email Service docs, read
> 2026-09-28. Each step is marked **verified** with a date once it has been performed for
> real — June dogfoods this on `agents.june.build`. When the feature ships, this guide is a
> `sources:` entry for the site's email page.
>
> Steps 1–4 were performed on `agents.june.build` on 2026-09-28 with OpenTofu (junebuild's
> infrastructure repository) and their results checked the same day through the Cloudflare
> API and DNS-over-HTTPS; what Cloudflare actually wrote is recorded below where it differs
> from the docs.

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

Cloudflare adds:

| record | name | value |
| --- | --- | --- |
| `MX` ×3 | `agents.example.com` | `route1/2/3.mx.cloudflare.net` (observed priorities 43 / 54 / 34) |
| `TXT` (SPF) | `agents.example.com` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `TXT` (SPF) | **the apex**, `example.com` | the same SPF |
| `TXT` (DKIM, routing) | **the apex**, `cf2024-1._domainkey.example.com` | the key routing signs forwards with |

The routing DKIM key and an SPF record land on the **apex**, not on the subdomain, even when
only the subdomain routes mail. If the apex has no `MX` of its own, the zone-level Email
Routing status reads `misconfigured` (the zone-level check, `GET /zones/{zone}/email/routing/dns`,
lists apex `MX` records as required); the
subdomain's own check (`GET /zones/{zone}/email/routing/dns?subdomain=…`) reports no errors,
and that is the one that matters here.

Infrastructure as code: `cloudflare_email_routing_dns` (Cloudflare provider 5.x) enables
routing for a name and writes these records.

A catch-all rule (`*@domain`) works on apex domains only; on a subdomain every address is
listed literally — `june build` emits the list from your agents' addresses.

Status: **verified 2026-09-28** on `agents.june.build`.

## 2. Turn on subaddressing

Dashboard: **Email Routing → Settings → Subaddressing**. It is off by default.

With it on, `support+anything@agents.example.com` is matched by the `support@…` rule and the
`+anything` part is preserved in `message.to`. June's signed reply addresses depend on it.

The setting is **zone-wide** (`support_subaddress` on `PATCH /zones/{zone}/email/routing`),
not per subdomain. With OpenTofu / Terraform, set it through that API call:
`cloudflare_email_routing_settings` (provider 5.26.0) cannot — its create enables routing on
the apex without the flag, its update is a no-op, and its delete disables Email Routing for
the whole zone.

Status: **verified 2026-09-28** — `support_subaddress: true` on the `june.build` zone.

## 3. Email Sending on the subdomain

Dashboard: **Compute → Email Service → Email Sending**, onboard `agents.example.com`.

Cloudflare adds, under the `cf-bounce` return-path host:

| record | name | value |
| --- | --- | --- |
| `MX` ×3 | `cf-bounce.agents.example.com` | `route1/2/3.mx.cloudflare.net` (bounces come back here) |
| `TXT` (SPF) | `cf-bounce.agents.example.com` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `TXT` (DKIM, sending) | `cf-bounce._domainkey.agents.example.com` | an RSA key |
| `TXT` (DMARC) | `_dmarc.agents.example.com` | **`p=reject`** — see step 4 |

Infrastructure as code: `cloudflare_email_sending_subdomain`.

Leave **Drop suppressed recipients** off (the default): a suppressed recipient then fails the
send with `E_RECIPIENT_SUPPRESSED` instead of being silently dropped. June checks suppression
before drafting.

Status: **verified 2026-09-28** on `agents.june.build`.

## 4. DMARC

Email Sending onboarding **writes a `_dmarc` record with `p=reject` itself**. Replace it
(or, with infrastructure as code, import it and manage it) with monitor mode while the first
reports come in:

```txt
v=DMARC1; p=none; rua=mailto:dmarc@agents.example.com
```

Sending the reports to an address on the same name needs no external authorization record;
add a routing rule that forwards `dmarc@` to a mailbox someone reads.

Move to `p=quarantine`, then `p=reject`, once the aggregate reports show only legitimate,
aligned mail. If `rua` points at another domain, that domain must publish a
`_report._dmarc` authorization record (RFC 7489 §7.1).

Status: **verified 2026-09-28** — `p=none`, `rua=mailto:dmarc@agents.june.build`. The forwarding
rule for `dmarc@` is declared in infrastructure as code; delivery through it not yet tested.

## 5. A verified destination address (for testing)

Dashboard: **Email Routing → Destination addresses**, add your own mailbox and confirm the
verification mail. Sends to verified destinations are free on every plan and do not count
toward quotas. Infrastructure as code: `cloudflare_email_routing_address`; creating one sends
the verification mail, and forwarding to it works only after the link is clicked.

Status: address created 2026-09-28; verification click not yet confirmed.

## 6. An API token for deploys

Two tokens, with different jobs:

- **Onboarding** (steps 1–5, usually infrastructure as code) — used successfully on
  2026-09-28 with: zone-level *Zone Write*, *DNS Write*, *Zone Settings Write*, *Email Routing
  Rules Write*; account-level *Email Sending Write*, *Email Routing Addresses Write*.
- **Deploying the Worker** — needs to edit Workers scripts and Email Routing rules
  (`addresses` in wrangler config creates rules owned by the Worker), and to use Email
  Sending; delivery events additionally need Queues and event subscriptions. Record the exact
  permission names here once a deploy has succeeded with it.

Status: onboarding token verified 2026-09-28; deploy token not yet created.

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

On a network that blocks outbound DNS, query over HTTPS instead, e.g.
`curl -s -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=agents.example.com&type=MX'`.

```sh
dig +short MX agents.example.com
dig +short TXT agents.example.com                      # routing SPF
dig +short TXT cf2024-1._domainkey.example.com         # routing DKIM (on the apex)
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
