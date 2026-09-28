// Content negotiation — turn a request into (RenderTarget, clean pathname,
// speculative?). Pure and host-free so it is trivially testable; the dev server
// and the built worker both route through it, so the negotiation can't drift.
//
// Precedence: an explicit URL extension (`/users.json`) wins over the Accept
// header — a link is unambiguous; Accept is a hint. The clean pathname (with
// the projection extension stripped) is what the router matches.

import { FRAGMENT_ACCEPT } from "@junejs/core/nav-protocol";
import type { RenderTarget } from "@junejs/core/route";

// The fragment media type + title header are the client-router wire protocol —
// defined once in @junejs/core so the browser router and this negotiator share
// the exact strings. Re-exported so existing server-side importers are unaffected.
export { FRAGMENT_ACCEPT, TITLE_HEADER, SEGMENT_HEADER, encodeTitle } from "@junejs/core/nav-protocol";

const EXT_TARGET: Record<string, RenderTarget> = {
  ".json": "json",
  ".md": "md",
};

// RFC 9110 §12.4.2 qvalue: 0–1 with at most three decimals ("0", "0.5", "1.000").
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

// Parse an Accept header into media-range → q (RFC 9110 §12.5.1). A q outside the
// qvalue grammar ("2", "-0.5", "0.1234") is malformed and reads as the default 1:
// the client still listed the type, so it stays acceptable at the default weight
// rather than being dropped or excluded. Parameters other than q are ignored.
function acceptRanges(accept: string): Map<string, number> {
  const ranges = new Map<string, number>();
  for (const part of accept.split(",")) {
    const [type, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    if (!type) continue;
    const raw = params.find((p) => p.startsWith("q="))?.slice(2).trim();
    ranges.set(type, raw !== undefined && QVALUE.test(raw) ? Number(raw) : 1);
  }
  return ranges;
}

// The projection an Accept header asks for — null when it asks for none of the
// agent projections (→ the HTML view). ONE decision shared by the pipeline and
// the deployed worker's asset layer (withAssets), so the two can't disagree.
//   - The client router's fragment media type (exact range, q > 0) wins outright.
//   - Markdown / JSON are chosen when listed with q > 0 and at least as preferred
//     as HTML; HTML's quality is text/html's, else the text/* or */* wildcard's.
//     So `text/markdown, text/html;q=0.9` → md, `text/html, text/markdown;q=0.5`
//     → HTML, and a plain browser Accept (no markdown/json) → HTML.
//   - Ties go to the agent projection (md before json), as they always have.
export function acceptTarget(accept: string): RenderTarget | null {
  const ranges = acceptRanges(accept);
  if ((ranges.get(FRAGMENT_ACCEPT) ?? 0) > 0) return "fragment";
  const html = ranges.get("text/html") ?? ranges.get("text/*") ?? ranges.get("*/*") ?? 0;
  const md = ranges.get("text/markdown") ?? 0;
  const json = ranges.get("application/json") ?? 0;
  const best = Math.max(md, json);
  if (best <= 0 || best < html) return null;
  return md >= json ? "md" : "json";
}

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

  if (!target) target = acceptTarget(request.headers.get("accept") ?? "");

  // A speculative request (Sec-Purpose: prefetch / prerender) may never be seen
  // — load()s read it to skip side effects (analytics, rate limits, counters).
  const purpose = request.headers.get("sec-purpose") ?? "";
  const speculative = /prefetch|prerender/.test(purpose);

  return { target: target ?? "view", pathname, speculative };
}
