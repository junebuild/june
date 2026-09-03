---
"@junejs/core": patch
---

The client router no longer hijacks fragment navigations. Browsers fire `popstate` for a `#hash` change too — a table-of-contents click, a pasted same-page deep link, back/forward between two anchors — and both routers (morph and Flight) treated every `popstate` as a history traversal: they re-fetched the page the reader was already on, re-applied it, and scrolled to `(0, 0)`. The visible symptom was an anchor jump that "worked" for half a second and then snapped back to the top of the page.

Each router now remembers the page (path + query) it last landed on and ignores a `popstate` that lands on the same page; the browser's own fragment scrolling is left intact. As the other half of the same contract, a soft-navigated link that carries a hash (`/guide#install`) now lands on that element after the morph — matching a hard load — and only falls back to the top when the hash names nothing on the new page. (The Flight router keeps landing at the top: its React render is asynchronous, so the target element does not exist yet when it would scroll.)
