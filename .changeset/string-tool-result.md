---
"@junejs/core": patch
---

The Anthropic adapter passes a string tool result through as-is (#172). It `JSON.stringify`'d every result, so a tool returning prose or JSON it had serialized itself reached the model as a quoted, escaped string (`"[{\"id\":…}]"`) — more tokens, harder to read. Non-string results are still JSON-encoded. The adapter conformance suite (`runAdapterConformance` in `@junejs/core/test`) gains a ninth scenario, "string tool result reaches the provider verbatim", so every adapter is held to the same contract; an adapter that encodes strings a second time now fails it.
