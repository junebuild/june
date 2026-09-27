// The generated web app manifest (/manifest.webmanifest) — Android's "Add to
// Home Screen" name, icons, and colours, built from the same config the
// document renders with. Worker-safe (no node:*): the pipeline serves it like
// the SVG favicon, so dev, the worker, and the static build all agree.
import { resolveThemeColor, type DocumentConfig } from "@junejs/core/document";

// The home-screen label: site.shortName, else the site name's leading segment
// ("June — build agents into real apps" → "June"). Launchers truncate past
// ~12 characters, and a tagline is never the label anyone wants.
export function shortName(site: DocumentConfig["site"]): string | undefined {
  if (site.shortName) return site.shortName;
  const name = site.name?.trim();
  if (!name) return undefined;
  return name.split(/\s+[—–|-]\s+|:\s+/)[0]!.trim() || name;
}

export function webManifest(config: DocumentConfig): string {
  const base = config.basePath ?? "";
  const theme = resolveThemeColor(config);
  // A manifest has ONE theme colour; a { light, dark } pair has no honest single
  // value, so both colour fields are left to the browser then.
  const color = typeof theme === "string" ? theme : undefined;
  const manifest = {
    name: config.site.name,
    short_name: shortName(config.site),
    description: config.site.description,
    start_url: `${base}/`,
    scope: `${base}/`,
    // "browser": a home-screen shortcut that opens a normal tab. standalone
    // (app-like, no URL bar) changes how a site behaves, so it stays opt-in via
    // your own public/manifest.webmanifest.
    display: "browser",
    ...(color ? { theme_color: color, background_color: color } : {}),
    icons: [
      { src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png" },
      // The same full-bleed art: its glyph sits inside the maskable safe zone.
      { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}
