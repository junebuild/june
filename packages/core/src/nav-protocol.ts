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
