---
"@junejs/core": patch
---

`anthropic()` checks that the loaded SDK's default export can actually be constructed, not just that it is a function. Arrow, async and generator functions pass a `typeof` test but not `new`, so an interop-wrapped module could still reach the low-level "… is not a constructor" error the #171 message was meant to replace; it now gets the helpful error too. The check uses `Reflect.construct` with the export only as `new.target`, so the export is never run. The SDK loading moves into `loadAnthropicSdk(importSdk?)` (exported; `importSdk` is a test seam), which lets the import-rejection path — and its `cause` — be tested directly.
