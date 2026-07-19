---
"@junejs/core": patch
"@junejs/server": patch
---

`@junejs/core` is now a peerDependency of `@junejs/server` (#94) — the app's single core resolution always wins, so a package manager can no longer nest a second, older core copy under server (the version-skew class that surfaced in production as a mid-turn `sink.emit is not a function`).

Belt-and-braces: core exports `RUNTIME_API_VERSION`, and server asserts it at surface construction (`AgentDurableObject`, `NativeRuntime`) — a skewed tree now fails at power-on with both versions named instead of mid-turn.

Migration: npm ≥7 / bun / pnpm auto-install required peers, so most apps need no change; if your tool doesn't, add `@junejs/core` to the app's dependencies (it almost certainly already is).
