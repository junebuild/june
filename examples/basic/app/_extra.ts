// The pre-route escape hatch fixture: app/_extra.* runs in BOTH dev and the
// built worker, after the agent surface and before route resolution. Return
// null to fall through to routes. parity.test.ts asserts dev ≡ worker on it.
export default function extra(_request: Request, url: URL): Response | null {
  if (url.pathname !== "/__extra/ping") return null;
  return new Response("pong from _extra", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
