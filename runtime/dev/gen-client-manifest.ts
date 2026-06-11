// Standalone: regenerate app/_client-manifest.ts. The dev watcher runs this when
// the set of "use client" modules changes (a component added/removed/renamed), so
// SSR can resolve the new references without a restart.
import { generateClientManifest } from "./client-manifest.ts";

generateClientManifest("runtime/app");
