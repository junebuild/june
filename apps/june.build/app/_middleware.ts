// The first five docs used to carry a numeric slug prefix (/docs/05-stability).
// Sidebar order now lives in `order` frontmatter, so no slug is numbered; the
// old URLs are linked from elsewhere and cached by agents, so they stay alive
// as a permanent redirect to the unnumbered slug, projection suffix included
// (/docs/05-stability.md → /docs/stability.md).
const NUMBERED_DOC = /^\/docs\/\d{2}-([^/]+)$/;

export default function middleware(_request: Request, url: URL): Response | null {
  const m = NUMBERED_DOC.exec(url.pathname);
  if (!m) return null;
  return new Response(null, {
    status: 301,
    headers: { location: `/docs/${m[1]}${url.search}` },
  });
}
