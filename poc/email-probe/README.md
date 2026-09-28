# PoC: Cloudflare Email Service live tests (email RFC §13)

**Status: run 2026-09-28** on `agents.june.build`, account-owned deploy token, wrangler
4.143.0. Answers the five questions `docs/rfc-email.md` §13 could not settle from
Cloudflare's docs.

A bare Worker, not a June app, so each behavior is observed without framework code in
between. It records and decides nothing:

- `email()` — keeps the envelope and the header block **in wire order with duplicates**
  (`Headers` would merge repeated fields, and test 1 is about which copy came from whom);
- `queue()` — keeps every Email Sending delivery event;
- `fetch()` — `GET /events` (the log) and `POST /send` (a send through the `send_email`
  binding), behind a bearer `PROBE_KEY`;
- `send_raw.py` — REST `send_raw` with a MIME message built locally.

Everything lands in one SQLite-backed Durable Object, so results survive a missed
`wrangler tail`.

## Results

| # | question | answer |
| --- | --- | --- |
| 1 | Does the message `email()` receives carry a trustworthy `Authentication-Results`? | **Yes.** Cloudflare prepends its own, `authserv-id` **`mx.cloudflare.net`**, with `dkim=`, `dmarc=` and `header.from=`, plus `ARC-Authentication-Results` (`i=1; mx.cloudflare.net`) and `Received-SPF`. A forged `Authentication-Results: agents.june.build; … dmarc=pass header.from=kaik.com` in the sent message **was delivered, below Cloudflare's**. So: trust only the topmost `Authentication-Results` whose `authserv-id` is `mx.cloudflare.net`; ignore every other copy. |
| 2 | Does REST `send_raw` keep a caller-set `Message-ID`? | **No — it is accepted, then replaced.** The API returns Cloudflare's own `message_id`, and the recipient sees that one; the caller's value does not appear anywhere in the delivered header block. But the returned id **is** the delivered `Message-ID` header, byte for byte — for `send_raw` and for the binding's `send()` alike. |
| 3 | Is a delivery event's `messageId` the one `send()` returned? | **Yes.** For all seven sends, event `payload.messageId` = the value `send()` / `send_raw` returned = the `Message-ID` header the recipient got. Events carry `recipient`, `sender`, `subject`, `terminal` and `delivery`, one per recipient. `delivery.deliveryTimeMs` was 300–600 ms; the event reached the queue consumer 4–6 s after the send. |
| 4 | Do subaddressing and a literal routing rule work together? | **Yes.** The literal rule `probe@agents.june.build → Worker` received `probe+t4bind9x@…` and `probe+T4Case@…`; `message.to` (the envelope) and the `To:` header both keep the `+tag`, **case preserved**. |
| 5 | What daily quota does the account start with? | **Not observable without spending it.** Sending to a non-verified recipient works on this account (all seven sends above went to `probe@agents.june.build`, which is not a verified destination). The quota is not published and has no API; it stays learned from `E_DAILY_LIMIT_EXCEEDED` in production. |

## Other findings

- **wrangler `addresses` fails with an account-owned deploy token.** `wrangler deploy`
  uploads the Worker, then calls the undocumented account-level
  `POST /accounts/{account}/email/routing/rules/plan`, which answered `10000 Authentication
  error` with each of: zone *Email Routing Rules Write* on `june.build`; plus account *Email
  Routing Account Rules Read* (the only account-scoped rules group; there is no Write); plus
  *Email Routing Rules Read*, then *Write*, on all zones of the account. The rule was created
  instead through the zone API (`POST /zones/{zone}/email/routing/rules`, action `worker`),
  which the zone-scoped *Email Routing Rules Write* allows. The all-zones grant was removed
  again afterwards.
- **Creating the Email Sending event subscription** (`wrangler queues subscription create …
  --source email.sending --zone-id … --domain agents.june.build`) needed nothing beyond
  *Queues Write* and *Email Sending Write*.
- **`send_raw` does not apply the header allowlist** the way the `headers` field does: the
  forged `Authentication-Results` (not on the allowlist) went through.
- **A caller-set `Date` in the future** (16:00 UTC, sent at 15:53) was accepted as `queued`,
  then neither delivered nor evented within minutes. Do not set `Date`.
- Cloudflare adds `X-CF-SpamH-Score` and a `Feedback-ID` to inbound mail, and signs
  outbound mail twice: `d=agents.june.build; s=cf-bounce` and `d=cloudflare-smtp.net;
  s=cf2024-1`. The envelope sender is `bounces@cf-bounce.agents.june.build`.
- Inbound `Authentication-Results` read `policy.dmarc=reject` for `agents.june.build` while
  its DNS record said `p=none` — the value Email Sending onboarding wrote a few hours earlier,
  probably cached.

## Setup (as run)

```sh
export CLOUDFLARE_API_TOKEN="$(security find-generic-password -s cloudflare-api-token-junebuild-agents-deploy -w)"
export CLOUDFLARE_ACCOUNT_ID=<account id>
W="bunx wrangler@4.143.0"

$W queues create june-email-probe-events
$W deploy
KEY="$(openssl rand -hex 24)"
security add-generic-password -U -a junebuild -s june-email-probe-key -w "$KEY"
printf '%s' "$KEY" | $W secret put PROBE_KEY
$W queues subscription create june-email-probe-events --source email.sending \
  --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained \
  --zone-id <zone id> --domain agents.june.build --name june-email-probe

# The inbound rule, through the zone API (see Other findings):
curl -X POST "https://api.cloudflare.com/client/v4/zones/<zone id>/email/routing/rules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"june-email-probe","enabled":true,
           "matchers":[{"type":"literal","field":"to","value":"probe@agents.june.build"}],
           "actions":[{"type":"worker","value":["june-email-probe"]}]}'
```

## Run

```sh
KEY="$(security find-generic-password -s june-email-probe-key -w)"
U=https://june-email-probe.<subdomain>.workers.dev

curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  "$U/send" --data '{"to":"probe+t4@agents.june.build"}'      # binding send (tests 3, 4)
./send_raw.py probe@agents.june.build msgid                     # test 2
./send_raw.py probe@agents.june.build forged                    # test 1
curl -H "Authorization: Bearer $KEY" "$U/events?limit=50"      # what was observed
```

## Teardown

Delete the routing rule, `wrangler queues subscription delete`, `wrangler delete`,
`wrangler queues delete june-email-probe-events`, and the `june-email-probe-key` Keychain
item. The deploy token `junebuild-agents-deploy-probe` expires 2026-10-12 by itself.
