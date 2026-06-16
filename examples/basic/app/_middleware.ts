// The pre-route middleware seam fixture: app/_middleware.* runs in BOTH dev and
// the built worker, after the agent surface and before route resolution. Return
// null to fall through to routes. parity.test.ts asserts dev ≡ worker on it.
// (A custom ENDPOINT like an og image belongs in a route.* resource route, not
// here — this is for genuine cross-cutting wrap/short-circuit only.)
export default function middleware(_request: Request, url: URL): Response | null {
  if (url.pathname !== "/__extra/ping") return null;
  return new Response("pong from _middleware", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
