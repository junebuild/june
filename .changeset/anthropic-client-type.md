---
"@junejs/core": patch
---

`anthropic({ client: new Anthropic() })` now type-checks against the real `@anthropic-ai/sdk` (#195). `AnthropicStreamEvent.delta` was an all-optional object type — a TypeScript "weak type" — and the SDK's stream also yields `message_delta`, whose `delta` (`{ stop_reason, stop_sequence, … }`) shares none of its keys, so `tsc` rejected the whole client (runtime was fine; Bun doesn't type-check). `delta` is now `unknown` and the adapter narrows it where it reads text and thinking deltas; an index signature would not have been enough, since the SDK declares its deltas as interfaces. The `as unknown as AnthropicClient` workaround can be dropped. A compile-time test now asserts the real SDK client against `AnthropicClient`, so SDK drift fails CI instead of an app's build.
