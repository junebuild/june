import type { OgFont } from "./fonts.ts";

/** Options accepted by ImageResponse across all backends. */
export interface ImageResponseOptions {
  width?: number;
  height?: number;
  /** Fonts to load for satori — use {@link loadGoogleFont} or {@link loadDefaultFonts}. */
  fonts?: OgFont[];
  /** HTTP status code. Default 200. */
  status?: number;
  /** Additional response headers (merged; do not override content-type). */
  headers?: Record<string, string>;
  /** Emoji rendering style (satori option). Default "twemoji". */
  emoji?: "twemoji" | "blobmoji" | "noto" | "openmoji";
  /** Render debug outlines (satori option). */
  debug?: boolean;
}
