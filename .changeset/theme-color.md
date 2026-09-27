---
"@junejs/core": patch
---

New `site.themeColor` sets `<meta name="theme-color">`, the mobile browser-toolbar colour. It takes one colour, or `{ light, dark }`, which emits one tag per `prefers-color-scheme`. Unset, the document uses June's starter background (`#fbfbf8`), but only when the starter look is the page's whole look: `cssReset` on, and no `global.css` or CSS Modules. With any app stylesheet the background is unknown, so no tag is emitted rather than a guessed colour.
