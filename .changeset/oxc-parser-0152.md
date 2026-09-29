---
"@junejs/server": patch
---

`oxc-parser` moves from `^0.151.0` to `^0.152.0`. A 0.x caret range never crosses a minor, so installs stayed on 0.151. `june build`'s island scan (`parseSync` over `client:*` pages) behaves the same on the newer parser.
