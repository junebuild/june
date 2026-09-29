---
"@junejs/server": patch
---

The built worker now ranks pages and resource routes the way `june dev` does (#312). It used to try static pages, then dynamic pages in manifest order, then resource routes, so `[slug]/page.tsx` answered `/feed.xml` ahead of `feed.xml/route.ts`, and a root `[[...slug]]` (Kura) swallowed `/og/*`: 200 in dev, 404 on Workers.

- Pages and resource routes now resolve from one table ranked the way dev does: `app/` before `.june/routes/`, then per segment static > `[param]` > `[[param]]` > `[...rest]` > `[[...rest]]`, then a page before a resource route at the same pattern. Route kind no longer decides precedence; segment shape does.
- The dev matcher orders sibling directories by the same ranking instead of `readdir` order, so `[slug]` answers before `[[slug]]` on every filesystem.
- A bracketed name that is not an identifier (`[1]`, `docs[v2`, `[slug].png`) is a static segment in dev and on the worker alike, matched literally.
- The manifest gains an optional `generatedRoutes` field (patterns from `.june/routes/`), emitted only when there are some.
- Two dev/worker differences remain and are tracked separately: a `(group)` dir is tried before a static sibling in dev (#314), and a non-trailing optional segment (`/[[lang]]/about`) matches `/about` only on the worker (#315).
