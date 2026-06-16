// The client-router wire protocol — shared by the SERVER (negotiate → the
// `fragment` projection) and the BROWSER router, so the media type and header
// names can't drift between the two ends.
//
// A soft navigation asks for the SAME url with this distinct Accept media type
// (a browser never sends it), so the fragment has no public URL surface. The
// response title rides back in a header so the client updates document.title
// without parsing the body.
export const FRAGMENT_ACCEPT = "text/vnd.june.fragment+html";
export const TITLE_HEADER = "x-june-title";

// Segment-scoped fragments (the granularity optimization): when a route's layout
// chain declares a boundary (`export const segmentBoundary = true` on a layout
// that renders <JuneOutlet>), the server renders only the chain BELOW the
// boundary — the persistent shell (sidebar/nav) is excluded.
//
// Three wire markers carry the boundary's identity so the client only morphs a
// fragment into a shell it actually belongs to:
//   OUTLET_ATTR  — the element <JuneOutlet> renders; the client morphs INTO it.
//   SHELL_ATTR   — on [data-june-root], the KEY of the mounted shell (which
//                  boundary layout owns it), written on every full document.
//   SEGMENT_HEADER — on a soft-nav fragment, the shell key the fragment is FOR.
// The client morphs the outlet only when the fragment's key (header) equals the
// mounted shell's key (SHELL_ATTR); otherwise it hard-navigates — so a cross-
// shell navigation, or a missing/forgotten <JuneOutlet>, loads the right shell
// instead of corrupting the page.
export const OUTLET_ATTR = "data-june-outlet";
export const SHELL_ATTR = "data-june-shell";
export const SEGMENT_HEADER = "x-june-segment";
