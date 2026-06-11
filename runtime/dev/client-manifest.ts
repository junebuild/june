// Generate app/_client-manifest.ts from the app's "use client" modules, so the
// SSR entry resolves client references without hand-registration. Shared by
// build.ts (full build) and dev/gen-client-manifest.ts (watcher, on add/remove).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function firstStatementIsDirective(src: string, directive: string): boolean {
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    return t.startsWith(`"${directive}"`) || t.startsWith(`'${directive}'`);
  }
  return false;
}

function exportNames(src: string): string[] {
  const names: string[] = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    const decl = t.match(
      /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/,
    );
    if (decl) names.push(decl[1]);
    else if (t.startsWith("export default")) names.push("default");
    const named = t.match(/^export\s*\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const e = part.split(" as ").pop()?.trim();
        if (e) names.push(e);
      }
    }
  }
  return names;
}

export function generateClientManifest(appDir: string) {
  const mods = walk(appDir)
    .filter((f) => /\.(tsx|ts|jsx|mjs)$/.test(f) && !f.endsWith("_client-manifest.ts"))
    .map((f) => ({ f, src: readFileSync(f, "utf8") }))
    .filter(({ src }) => firstStatementIsDirective(src, "use client"))
    .map(({ f, src }) => ({ rel: "./" + f.slice(appDir.length + 1), exports: exportNames(src) }));

  let out = '// AUTO-GENERATED from "use client" modules — do not edit\n';
  mods.forEach((m, i) => (out += `import * as m${i} from ${JSON.stringify(m.rel)};\n`));
  out += "\nexport const CLIENT_MODULES = {\n";
  mods.forEach((m, i) =>
    m.exports.forEach((n) => (out += `  ${JSON.stringify(n)}: { ${JSON.stringify(n)}: m${i}[${JSON.stringify(n)}] },\n`)),
  );
  out += "};\n\nexport const CLIENT_MODULE_MAP = {\n";
  mods.forEach((m) =>
    m.exports.forEach(
      (n) => (out += `  ${JSON.stringify(n)}: { ${JSON.stringify(n)}: { id: ${JSON.stringify(n)}, chunks: [], name: ${JSON.stringify(n)} } },\n`),
    ),
  );
  out += "};\n";
  writeFileSync(join(appDir, "_client-manifest.ts"), out);
  console.log(`generated app/_client-manifest.ts (${mods.length} "use client" modules)`);
}
