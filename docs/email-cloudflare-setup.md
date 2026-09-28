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

Status: **verified 2026-09-28** — the destination address was confirmed, and the `dmarc@`
forwarding rule to it is present and enabled (`GET /zones/{zone}/email/routing/rules`).

## 6. An API token for deploys

Two tokens, with different jobs. Keep them apart: the token that onboards DNS never needs to
deploy code, and the token that deploys code never needs to touch DNS.

**Onboarding** (steps 1–5, usually infrastructure as code) — used successfully on 2026-09-28
with: zone *Zone Write*, *DNS Write*, *Zone Settings Write*, *Email Routing Rules Write*;
account *Email Sending Write*, *Email Routing Addresses Write*.

**Deploying the Worker** (it also creates routing rules and the event subscription, steps 7–8)
— an **account-owned** token (it outlives any one person's user
account), limited to one account and one zone:

| scope | permission group | id | why |
| --- | --- | --- | --- |
| account | Workers Scripts Write | `e086da7e2179491d91ee5f35b3ca210a` | upload the Worker |
| account | Email Sending Write | `5df633d6b41c42bcaf5b4a62b9d14b64` | the `send_email` binding and REST `send` / `send_raw`; also reads suppressions |
| account | Queues Write | `366f57075ffc42689627bcf8242a1b6d` | the delivery-event queue |
| account | Account Settings Read | `c1fde68c7bcc44588cbb6ddbc16d6480` | account lookups during deploy |
| zone | Email Routing Rules Write | `79b3ec0d10ce4148a8f8bdc0cc5f97f2` | create the Worker's routing rules through the zone API (step 7) |
| zone | Zone Read | `c8fed203ed3043cba015a93ad1616f1f` | resolve the zone |

Permission-group ids are global; they were read from
`GET /accounts/{account}/tokens/permission_groups` on 2026-09-28. No group is named for event
subscriptions; *Queues Write* with *Email Sending Write* is enough to create one (verified in
step 8).

No *Workers Tail Read*: *Workers Scripts Write* already covers `wrangler tail`. A token with
exactly the policy above tailed the probe Worker (2026-09-28). So whoever holds the deploy token
can read what the Worker logs; leaving out *Workers Tail Read* does not prevent it. Keep secrets
and message bodies out of logs.

As infrastructure as code (Cloudflare provider 5.x, `cloudflare_account_token`). Running it
needs a token with *Account API Tokens Write*, which can mint any token — keep that bootstrap
credential out of the stacks that manage DNS or code, and note that the new token's value is
stored in state, so the state backend must be treated as a secret store:

```hcl
resource "cloudflare_account_token" "agents_deploy" {
  account_id = var.cloudflare_account_id
  name       = "agents-deploy"
  policies = [
    {
      effect = "allow"
      permission_groups = [
        { id = "e086da7e2179491d91ee5f35b3ca210a" }, # Workers Scripts Write
        { id = "5df633d6b41c42bcaf5b4a62b9d14b64" }, # Email Sending Write
        { id = "366f57075ffc42689627bcf8242a1b6d" }, # Queues Write
        { id = "c1fde68c7bcc44588cbb6ddbc16d6480" }, # Account Settings Read
      ]
      resources = jsonencode({ "com.cloudflare.api.account.${var.cloudflare_account_id}" = "*" })
    },
    {
      effect = "allow"
      permission_groups = [
        { id = "79b3ec0d10ce4148a8f8bdc0cc5f97f2" }, # Email Routing Rules Write
        { id = "c8fed203ed3043cba015a93ad1616f1f" }, # Zone Read
      ]
      resources = jsonencode({ "com.cloudflare.api.account.zone.${var.zone_id}" = "*" })
    },
  ]
}

output "agents_deploy_token" {
  value     = cloudflare_account_token.agents_deploy.value
  sensitive = true
}
```

Without infrastructure as code, the same policies go to
`POST /accounts/{account}/tokens` as JSON (`resources` as an object rather than an encoded
string); set `expires_on` for a token meant only for a test window.

Status: **verified 2026-09-28** — a deploy token was created through the API for the test
window, then again from the OpenTofu template above (`cloudflare_account_token`); both also
carried *Workers Tail Read*, which turned out redundant. A short-lived token with exactly these
policies deployed the probe Worker, created and deleted a zone routing rule, listed the queue and
its event subscription, tailed the Worker, and was refused on DNS records and on token
management.

## 7. Wrangler configuration and routing rules

`june build` will emit the bindings from your agents' definitions; shown here so the moving
parts are visible:

```jsonc
{
  // outbound: one binding per agent, restricted to that agent's own addresses
  "send_email": [
    {
      "name": "EMAIL_SUPPORT",
      "allowed_sender_addresses": ["support@agents.example.com", "hello@agents.example.com"]
    }
  ],
  // delivery events (step 8)
  "queues": { "consumers": [{ "queue": "agents-email-events" }] }
}
```

**Routing rules go through the zone API, not wrangler `addresses`.** With an account-owned
deploy token, `wrangler deploy` uploads the Worker and then fails on the undocumented
account-level `POST /accounts/{account}/email/routing/rules/plan` (`10000 Authentication
error`); no grantable permission tried satisfied it (zone *Email Routing Rules Write*,
account *Email Routing Account Rules Read*, and *Email Routing Rules Read* / *Write* on all
zones). The zone API works with the step 6 token:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/zones/<zone id>/email/routing/rules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"support","enabled":true,
           "matchers":[{"type":"literal","field":"to","value":"support@agents.example.com"}],
           "actions":[{"type":"worker","value":["<worker name>"]}]}'
```

One literal rule per address; with subaddressing on (step 2), `support+anything@…` reaches
the same Worker with the `+anything` part — and its letter case — kept in `message.to`.

Status: **verified 2026-09-28** with `poc/email-probe` (send binding, queue consumer, a
zone-API rule; subaddressed deliveries received).

## 8. Delivery events

Email Sending publishes `message.delivered | deferred | bounced | failed | rejected |
complained` through **Queues event subscriptions**, one subscription per sending domain:

```sh
wrangler queues create agents-email-events
wrangler queues subscription create agents-email-events --source email.sending \
  --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained \
  --zone-id <zone id> --domain agents.example.com
```

The step 6 token is enough (*Queues Write* and *Email Sending Write*). The Worker consumes the
queue in a `queue()` handler. Each event names one recipient, and its `payload.messageId` is
exactly the id `send()` returned — which is also the `Message-ID` header the recipient sees.
Sends to **verified destination addresses** are routing deliveries and publish no sending
events; test with a non-verified recipient.

Status: **verified 2026-09-28** — seven sends, seven `message.delivered` events, all ids
matching.

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

- **`Message-ID` is Cloudflare's.** The `headers` field rejects a caller-set `Message-ID`, and
  REST `send_raw` accepts one but replaces it. The id `send()` / `send_raw` returns is the
  delivered `Message-ID`, so store it — replies can be matched by `In-Reply-To`.
- **Never set `Date`.** A caller-set future `Date` in `send_raw` left the message `queued`
  and undelivered.
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
