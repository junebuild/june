// Content negotiation — turn a request into (RenderTarget, clean pathname,
// speculative?). Pure and host-free so it is trivially testable; the dev server
// and the built worker both route through it, so the negotiation can't drift.
//
// Precedence: an explicit URL extension (`/users.json`) wins over the Accept
// header — a link is unambiguous; Accept is a hint. The clean pathname (with
// the projection extension stripped) is what the router matches.

import type { RenderTarget } from "@junejs/core/route";

// The fragment media type + title header are the client-router wire protocol —
// defined once in @junejs/core so the browser router and this negotiator share
// the exact strings. Re-exported so existing server-side importers are unaffected.
export { FRAGMENT_ACCEPT, TITLE_HEADER, SEGMENT_HEADER, encodeTitle } from "@junejs/core/nav-protocol";

const EXT_TARGET: Record<string, RenderTarget> = {
  ".json": "json",
  ".md": "md",
};

const ACCEPT_TARGET: Array<[test: RegExp, target: RenderTarget]> = [
  // fragment first: its media type is exact + can't collide with browser Accepts.
  [/text\/vnd\.june\.fragment\+html/, "fragment"],
  [/text\/markdown/, "md"],
  [/application\/json/, "json"],
];

export type Negotiated = {
  target: RenderTarget;
  pathname: string; // projection extension stripped
  speculative: boolean;
};

// `basePath` overrides the pathname to negotiate (defaults to url.pathname). The
// i18n step strips the locale prefix off the FRONT of url.pathname first and
// passes the remainder here, so extension/Accept negotiation runs on the route
// path, not the locale-prefixed one. url.pathname stays the raw request path.
export function negotiate(url: URL, request: Request, basePath?: string): Negotiated {
  const original = basePath ?? url.pathname;
  let pathname = original;
  let target: RenderTarget | null = null;

  for (const [ext, t] of Object.entries(EXT_TARGET)) {
    if (pathname.endsWith(ext)) {
      target = t;
      pathname = pathname.slice(0, -ext.length) || "/";
      break;
    }
  }

  // "/index" is the conventional alias for the home route "/": the home page's
  // projections live at the intuitive `/index.md` / `/index.json` (and plain
  // `/index` serves the home view), matching the build's `index.md` / `index.json`
  // assets.
  if (pathname === "/index") {
    pathname = "/";
  } else if (target && pathname === "/") {
    // A bare projection on the root — `/.md`, `/.json` — is NOT a real URL (the
    // home surface is `/index.md`). Stripping the extension collapses it to "/",
    // so steer it back to the literal path: no route matches → 404.
    pathname = original;
  }

  if (!target) {
    const accept = request.headers.get("accept") ?? "";
    for (const [re, t] of ACCEPT_TARGET) {
      if (re.test(accept)) {
        target = t;
        break;
      }
    }
  }

  // A speculative request (Sec-Purpose: prefetch / prerender) may never be seen
  // — load()s read it to skip side effects (analytics, rate limits, counters).
  const purpose = request.headers.get("sec-purpose") ?? "";
  const speculative = /prefetch|prerender/.test(purpose);

  return { target: target ?? "view", pathname, speculative };
}
