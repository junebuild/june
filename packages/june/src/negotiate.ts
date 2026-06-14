// Content negotiation — turn a request into (RenderTarget, clean pathname,
// speculative?). Pure and host-free so it is trivially testable; the dev server
// and the built worker both route through it, so the negotiation can't drift.
//
// Precedence: an explicit URL extension (`/users.json`) wins over the Accept
// header — a link is unambiguous; Accept is a hint. The clean pathname (with
// the projection extension stripped) is what the router matches.

import type { RenderTarget } from "@junejs/core/route";

// The client router asks for a fragment of the SAME url via this distinct media
// type (a browser never sends it), so the fragment has no URL surface — Accept
// only. The title rides back in a header so the client updates document.title
// without parsing the body.
export const FRAGMENT_ACCEPT = "text/vnd.june.fragment+html";
export const TITLE_HEADER = "x-june-title";

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

export function negotiate(url: URL, request: Request): Negotiated {
  let pathname = url.pathname;
  let target: RenderTarget | null = null;

  for (const [ext, t] of Object.entries(EXT_TARGET)) {
    if (pathname.endsWith(ext)) {
      target = t;
      pathname = pathname.slice(0, -ext.length) || "/";
      break;
    }
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
