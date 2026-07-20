---
"@junejs/core": patch
---

`slackChannel(...).diagnose()` (#90) — preflight diagnostics as one structured, read-only call: verifies the bot token (`auth.test`), compares granted scopes (the `x-oauth-scopes` response header) against what the ENABLED features need (stream/status → `assistant:write`, reaction events → `reactions:read`, …), and reports per-isolate delivery counters (events received per kind — un-normalizable events count under their raw Slack type — plus interactions split three ways: claimed by a built-in branch / delivered to `onInteraction` (`appHandled`) / unrouted, and rejection counts). `hints` renders the findings as one-liners: "app_mention received: 0 since this isolate started — check Socket Mode is OFF and the Events Request URL points at this deployment" is the packaged answer to the silent-failure hunt that motivated the issue.
