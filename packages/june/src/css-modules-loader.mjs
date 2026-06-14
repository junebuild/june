// Node ESM loader for CSS Modules (dev). `module.register` runs this in its own
// context, so it must be a plain, self-contained .mjs — it does NOT transform;
// it just looks up the precomputed class map (handed in via init data) and
// returns it as a JS module. The maps come from css-modules.ts's single glob
// pass, so the served CSS and these maps agree by construction.
import { fileURLToPath } from "node:url";

let MAPS = {};

export function initialize(data) {
  MAPS = (data && data.maps) || {};
}

export async function load(url, context, next) {
  if (url.endsWith(".module.css")) {
    const map = MAPS[fileURLToPath(url)] || {};
    return { format: "module", source: "export default " + JSON.stringify(map) + ";", shortCircuit: true };
  }
  return next(url, context);
}
