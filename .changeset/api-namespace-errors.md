---
"@junejs/core": minor
"@junejs/server": patch
---

`/api` answers as an API when nothing else claims a path there (with `agent.api` on).

- `GET /api` (and `/api/`) returns a JSON index: the `/openapi.json` URL, each
  served action as `{ id, method: "POST", path, description }`, and the error
  shape, with a `Link: </openapi.json>; rel="service-desc"` header. HEAD gets
  the same headers with no body, and any other method gets a 405 JSON error
  (`Allow: GET, HEAD`).
- Any other unmatched path under `/api/` gets the REST surface's JSON 404,
  `{ error: { code: "not_found", message, hint } }`, for every method and every
  `Accept` (it used to fall through to the HTML not-found page). No versions are
  invented: `/api/v1` is a miss like any other path.
- Order under `/api`: a registered action's `/api/<id>` is dispatched before
  routing, as before. Every other path goes to the app's routes, so an app
  route at `/api` or at any `/api/<path>` that isn't an action replaces the
  index or the error there. Only a path neither claims gets them. With
  `agent.api` off, `/api` is an ordinary path again. A static build prerenders
  nothing for `/api`.
- New `@junejs/core/api` exports: `apiIndex`, `apiNamespaceResponse`,
  `isApiNamespace`.
- Fix (server): a request path with a malformed percent-escape (`/docs/%ZZ`,
  `/blog/%E0%A4%A`) crashed the request instead of 404ing. Every route resolver
  (the dev tree matcher and the built worker's route tables) decodes URL
  segments, and the `URIError` escaped: `app.fetch` threw on the dev server, and
  `wrangler dev` answered 500 `URIError: URI malformed`. Cloudflare's edge
  rejects such URLs with a 400 before the worker runs, so deployed Workers
  weren't affected, but other hosts were. The pipeline now checks that every
  segment of the path decodes BEFORE resolving. A path that doesn't is a routing
  miss (the normal negotiated 404, or the API's JSON 404 under `/api`) and never
  reaches a resolver. Anything a resolver itself throws, including a genuine
  `URIError` from a route module, still propagates.
