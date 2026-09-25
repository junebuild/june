---
"@junejs/core": patch
---

`slackChannel({ stream: true, intermediateText: "status" })` keeps pre-tool text out of the answer (#175). Streaming forwarded text from every model step, so a step that said "Let me search the docs…" before calling a tool left that preamble at the top of the posted answer. With `intermediateText: "status"`, each step's text is held until the step ends: if it ends in a tool call, the text renders as progress — a task-timeline entry when `tasks` is on, otherwise the status line under the composer — and only the final step's text becomes the answer. A Slack stream can't take text back and a step's outcome is known only when it ends, so the answer then appears whole rather than token by token. The default, `"answer"`, keeps today's behavior.
