---
"@junejs/core": patch
---

Slack DM streams omit recipient ids (live-verified): chat.startStream's recipient rule cuts both ways — a channel stream requires `recipient_user_id`/`recipient_team_id` (`missing_recipient_team_id`), while a DM stream rejects them (`invalid_arguments`). The renderer now branches on the im channel's D-prefix, so streaming works in both surfaces. Also documents the observed rendering surfaces: task cards render in regular channels; feedback buttons attach everywhere but clients may only render them in the agent DM; the Stop affordance is agent-surface-only (our `stopped_by_user` handling is defensive regardless).
