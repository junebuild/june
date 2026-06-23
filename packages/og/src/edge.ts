// Vercel Edge / edge-light backend — resolved when the build uses the "edge-light" condition.
// @vercel/og bundles its own resvg WASM compatible with Vercel's Edge Runtime.
export { ImageResponse } from "@vercel/og";
export type { ImageResponseOptions } from "./types";
export { loadGoogleFont, loadDefaultFonts, hasCJK, OG_HEADERS } from "./fonts";
export type { OgFont } from "./fonts";
