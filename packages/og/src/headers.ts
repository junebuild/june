import { OG_HEADERS } from "./fonts";
import type { ImageResponseOptions } from "./types";

/**
 * The response headers every backend's ImageResponse answers with.
 *
 * Merged through `Headers.set`, which is case-insensitive: a caller's
 * `Cache-Control` replaces the default instead of joining it. An object spread
 * (`{ "cache-control": …, ...options.headers }`) keeps both spellings as
 * separate keys, and `new Headers(init)` then appends their values.
 *
 * Contract (types.ts): callers may merge or override any header EXCEPT
 * content-type, which is set last so the body is always served as a PNG.
 */
export function ogResponseHeaders(options: ImageResponseOptions): Headers {
  const headers = new Headers({ "cache-control": OG_HEADERS["cache-control"] });
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  headers.set("content-type", "image/png");
  return headers;
}
