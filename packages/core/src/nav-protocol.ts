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
// boundary — the persistent shell (sidebar/nav) is excluded. The marker
// attribute is the element <JuneOutlet> renders; the client morphs INTO it
// instead of [data-june-root]. The response header tells the client the fragment
// is segment-scoped, so it targets the outlet (and hard-navigates if the author
// declared the boundary but forgot to render <JuneOutlet> — no live outlet).
export const OUTLET_ATTR = "data-june-outlet";
export const SEGMENT_HEADER = "x-june-segment";
