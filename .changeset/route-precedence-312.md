---
"@junejs/server": patch
---

The built worker picks the same route as `june dev` for every path (#312). It used to try static pages, then dynamic pages in manifest order, then resource routes, so `[slug]/page.tsx` answered `/feed.xml` ahead of `feed.xml/route.ts`, and a root `[[...slug]]` (Kura) swallowed `/og/*`: 200 in dev, 404 on Workers.

- Pages and resource routes now resolve from one table ranked the way dev does: `app/` before `.june/routes/`, then per segment static > `[param]` > `[[param]]` > `[...rest]` > `[[...rest]]`, then a page before a resource route at the same pattern. Route kind no longer decides precedence; segment shape does.
- The dev matcher orders sibling directories by the same ranking instead of `readdir` order, so `[slug]` answers before `[[slug]]` on every filesystem.
- The manifest gains an optional `generatedRoutes` field (patterns from `.june/routes/`), emitted only when there are some.
