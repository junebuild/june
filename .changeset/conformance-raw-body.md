---
"@junejs/core": patch
---

`runAdapterConformance`: a transport stub that captures the serialized request body (a string) is no longer serialized a second time before the content checks. The escape-sensitive "string tool result reaches the provider verbatim" scenario (#172) misread that extra layer and failed a faithful adapter; object-shaped captures are stringified as before.
