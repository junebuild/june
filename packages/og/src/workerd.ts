// Cloudflare Workers backend — resolved when the build uses the "workerd" export condition.
// workers-og wraps satori + a Workers-compatible resvg WASM loader; mark it as buildExternal
// in june.config.ts so wrangler's own WASM rules can handle its .wasm assets:
//   build: { external: ["workers-og"] }
export { ImageResponse } from "workers-og";
export type { ImageResponseOptions } from "./types";
export { loadGoogleFont, loadDefaultFonts, hasCJK, OG_HEADERS } from "./fonts";
export type { OgFont } from "./fonts";
