---
"@junejs/core": patch
---

`anthropic()`'s missing-SDK error now names the bundling fix (#171). The adapter loads `@anthropic-ai/sdk` lazily through a non-literal specifier so the dependency stays optional — which also makes it invisible to bundlers, so a `bun build --compile` binary or a single-file Worker bundle fails at the first model call unless a `node_modules` sits beside it. The error said only "install @anthropic-ai/sdk", which is wrong advice there. It now says to import the SDK in the app and pass `client: new Anthropic({ … })`, keeps the import failure as `cause`, and also covers a module that loads without a usable default export (previously "undefined is not a constructor"). The `client` option's doc says the same, and `examples/agent-edge` — which called `anthropic()` without `client` and without the SDK as a dependency, so it could not have loaded on workerd with a key set — now injects it, like the worker `june build` generates.
