---
"@junejs/server": patch
---

`june dev` no longer lets a route group shadow a static sibling (#314). The dev matcher tried every `(group)` dir before the exact static dir at the same level, so `app/(g)/[slug]/page.tsx` answered `/about` ahead of `app/about/page.tsx`, while the built worker (which strips groups from patterns) served `about`. A group's children now rank as siblings of the level the group sits in, same-named dirs in different groups (`(a)/blog`, `(b)/blog`) descend together, and a page beats a `route.ts` at the same path whichever group holds it — so dev picks the same route as the built worker. A group's layout still wraps the route that wins.

Two route files that resolve to the same path in one tree (`(a)/about/page.tsx` and `(b)/about/page.tsx`, or `page.tsx` next to `index.tsx`) have no defined winner, so `june build` now fails and lists them, and `june dev` reports them at startup. A page next to a `route.ts` is still allowed (the page wins), and a path in both `app/` and `.june/routes/` still resolves to `app/`.
