---
"@junejs/core": minor
---

`@junejs/core/supervise`: the agent supervision contract, version 1 (#297, email RFC §9.1).

What an operator surface — `june inbox`, a TUI, a web page, a coding agent — reads and sends to
supervise an agent, channel-neutral (a Slack approval and an email draft are the same record):

- `PendingAction` — an input a turn parked on: the prompt, the answer's schema, who may answer,
  the tool call that parked (what the agent wants to do), where the turn came from, how many
  inbound turns are held behind it, and how it was resolved.
  Its origin never carries the resolved principal or the platform payload — both are
  forbidden in the type and the schema.
- `Decision` — approve (the tool receives the edited answer when given, else `true`) or reject
  (the tool receives `false`; an optional note joins the session as an operator note).
- `TurnTrace` and `traceTurn(msgs, ids)` — a turn's prompt, each tool call with its outcome, and
  its last words, folded from the durable log so every host shows the same thing.
- `PendingPage`, the `pending.created` / `pending.updated` / `pending.resolved` `InboxEvent`s
  (a client reads `AnyInboxEvent` and narrows with `isKnownInboxEvent`),
  and `SuperviseError` (`already_resolved` carries who resolved it and when).
- `superviseSchema` — one JSON Schema (draft 2020-12) document, `$id` `urn:june:supervise:1`,
  with a `$defs` entry per type, for clients in other languages.

`SUPERVISE_CONTRACT_VERSION` changes only on a breaking change; clients must ignore fields,
event kinds and error codes they don't know. Statuses, outcomes, decision kinds and answerers
are closed sets: adding to them is breaking. Types, schema and one pure fold only —
`@junejs/server` implements the index and the API next.
