---
"@junejs/core": patch
---

Channel webhook hardening (slack + crisp):

- Replay guard: crispChannel now rejects a stale timestamp (±5 min), matching slackChannel. The shared `timestampFresh` helper is unit-agnostic (Slack sends seconds, Crisp milliseconds).
- Malformed body: a signature-valid but unparseable webhook body now ACKs 200 and is dropped instead of throwing — a 5xx would make the platform redeliver the same broken event forever (retry storm).
- Inbound guard: a whitespace-only visitor message no longer triggers an agent turn.
