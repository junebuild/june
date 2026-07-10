// Static-file serving for the app-root `public/` directory — the ONE place that
// maps a URL path to a verbatim file. Shared by the dev host (app.ts, node:fs)
// and the Deno adapter runtime (withDenoAssets, Deno.readFile). Cloudflare and
// Vercel serve public files through their own platform layer (the ASSETS binding
// / the `filesystem` route handle) and don't call in here.
//
// `public/` is PASSTHROUGH: no content-hashing, no format conversion, no
// optimization — that stays the future image service's job. This module is pure
// (no node built-ins) so it bundles cleanly into the worker (Deno/edge) too.

// The framework owns this top-level URL segment (hashed client bundle + CSS live
// under it). A user file must never be served from `public/_june/...`, so the
// dev lookup and the build copy both skip it. NOTE: the Deno runtime asset server
// legitimately serves `/_june/*` (the real framework assets), so it does NOT
// apply this reservation — safeRelativePath() below is traversal-only.
export const RESERVED_PREFIX = "_june";

// Extension → MIME. Deliberately small and explicit (no `mime` dependency): the
// set of things people actually drop in public/. Unknown → octet-stream.
const CONTENT_TYPES: Record<string, string> = {
  // text / markup
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  webmanifest: "application/manifest+json",
  // images
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  // fonts
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  // media / binary
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function contentTypeFor(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return CONTENT_TYPES[pathname.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

// Clean a URL pathname into a safe relative path (forward-slash separated) under
// a static root, or null if it is malformed, empty, or escapes the root. Callers
// join the result to their own root (node:path.join for dev, a URL for Deno).
// Traversal guard ONLY — the reserved `_june` segment is enforced by callers, not
// here, because the Deno asset server must be able to serve it.
export function safeRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed %-encoding
  }
  // A backslash or NUL in a URL path is never a legitimate static file request;
  // rejecting them closes the Windows separator / null-byte traversal tricks.
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null; // "/" is a page, not a file
  if (segments.some((s) => s === "..")) return null; // no directory climbing
  return segments.join("/");
}
