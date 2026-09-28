---
"@junejs/server": patch
---

`oxc-parser` moves from `^0.137.0` to `^0.151.0`. A 0.x caret range never crosses a minor, so installs were held at 0.137 while the project shipped fourteen releases; `june build`'s island scan (`parseSync` over `client:*` pages) behaves the same on the newer parser.
