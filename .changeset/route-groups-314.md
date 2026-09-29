---
"@junejs/server": patch
---

`june dev` no longer lets a route group shadow a static sibling (#314). The dev matcher tried every `(group)` dir before the exact static dir at the same level, so `app/(g)/[slug]/page.tsx` answered `/about` ahead of `app/about/page.tsx`, while the built worker (which strips groups from patterns) served `about`. A group's children now rank as siblings of the level the group sits in, so dev picks the same route as the built worker; the group's layout still wraps the route that wins. Production behavior is unchanged.
