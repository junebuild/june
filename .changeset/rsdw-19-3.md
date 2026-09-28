---
"@junejs/server": patch
---

The `react-server-dom-webpack` peer moves from `19.2.7` to `19.3.0`. The react-family catalog keeps `react` / `react-dom` at `^19.2.0`, so a fresh install already resolves React 19.3.0. Until now that meant pairing 19.3 with a Flight runtime pinned to 19.2.7, a mix React does not guarantee. RSDW 19.3.0 declares `react` / `react-dom` `^19.3.0` itself, so apps that use React Server Components now line up on 19.3. Apps without RSC are unaffected: the `react` peer range of every June package is unchanged.

Migration: if the app pins React below 19.3 and installs `react-server-dom-webpack`, upgrade `react`, `react-dom` and `react-server-dom-webpack` together to 19.3.0.
