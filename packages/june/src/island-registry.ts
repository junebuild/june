// Auto-generate the island registry by scanning ISLAND USAGE — every
// `<Counter client:*/>` in the app — and resolving the component's import AT THE
// USAGE SITE. Writes app/_islands.gen.ts mapping each island name to a lazy loader
// that dynamic-imports its module and resolves the component export.
//
// Usage-driven, so a third-party (lib) island is discovered the same way as an app
// one — the import specifier is right there at the call site (no lib manifest, no
// scan of node_modules). The KEY is the imported name = the component's runtime name
// = the marker the JSX runtime stamps, so all three agree by construction.
//
// Host-coupled (node:fs + oxc-parser), so it lives in @junejs/server.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

import { parseSync } from "oxc-parser";

export const ISLAND_REGISTRY_FILE = "_islands.gen.ts";

// Shared with rsc-manifest.ts (the RSC client-reference codegen).
export function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// True iff the first real statement (skipping blanks + line comments) is the
// directive — used by the RSC manifest codegen.
export function firstStatementIsDirective(src: string, directive: string): boolean {
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    return t.startsWith(`"${directive}"`) || t.startsWith(`'${directive}'`);
  }
  return false;
}

// The named exports of a module — used by the RSC manifest codegen.
export function exportNames(src: string): string[] {
  const names: string[] = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    const decl = t.match(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/);
    if (decl) names.push(decl[1]!);
    const named = t.match(/^export\s*\{([^}]*)\}/);
    if (named) {
      for (const part of named[1]!.split(",")) {
        const e = part.split(" as ").pop()?.trim();
        if (e) names.push(e);
      }
    }
  }
  return names;
}

type Import = { spec: string; imported: string; kind: "named" | "default" | "namespace" };

// local binding name → its import, for one module.
function importMap(program: { body: any[] }): Map<string, Import> {
  const map = new Map<string, Import>();
  for (const n of program.body) {
    if (n.type !== "ImportDeclaration" || typeof n.source?.value !== "string") continue;
    const spec = n.source.value as string;
    for (const s of n.specifiers ?? []) {
      if (s.type === "ImportSpecifier") map.set(s.local.name, { spec, imported: s.imported.name, kind: "named" });
      else if (s.type === "ImportDefaultSpecifier") map.set(s.local.name, { spec, imported: "default", kind: "default" });
      else if (s.type === "ImportNamespaceSpecifier") map.set(s.local.name, { spec, imported: "*", kind: "namespace" });
    }
  }
  return map;
}

// Does this JSX element carry a `client:*` directive?
function hasClientDirective(openingElement: any): boolean {
  return (openingElement.attributes ?? []).some(
    (a: any) => a.type === "JSXAttribute" && a.name?.type === "JSXNamespacedName" && a.name.namespace?.name === "client",
  );
}

// Collect every JSX element tag used with a client:* directive (recursive walk).
function islandTags(program: { body: any[] }): string[] {
  const tags: string[] = [];
  (function walkNode(node: any) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walkNode);
    if (node.type === "JSXElement" && node.openingElement?.name?.type === "JSXIdentifier" && hasClientDirective(node.openingElement)) {
      tags.push(node.openingElement.name.name);
    }
    for (const k in node) if (k !== "type") walkNode(node[k]);
  })(program);
  return tags;
}

// Write app/_islands.gen.ts. Returns the number of island loaders emitted.
export function generateIslandRegistry(appDir: string): number {
  const seen = new Map<string, string>(); // island name → loader specifier (dup guard)
  const entries: string[] = [];

  for (const f of walk(appDir)) {
    if (!/\.(tsx|jsx)$/.test(f) || f.endsWith(ISLAND_REGISTRY_FILE) || f.endsWith(".gen.ts")) continue;
    const src = readFileSync(f, "utf8");
    if (!src.includes("client:")) continue; // cheap pre-filter
    const { program } = parseSync(f, src);
    const ast = program as { body: any[] };
    const imports = importMap(ast);
    const rel = "./" + relative(appDir, f);

    for (const tag of islandTags(ast)) {
      const imp = imports.get(tag);
      if (!imp) {
        throw new Error(
          `[june] <${tag} client:*/> in ${rel}: an island must be an IMPORTED component (a named import), not a local definition.`,
        );
      }
      if (imp.kind !== "named") {
        throw new Error(
          `[june] <${tag} client:*/> in ${rel}: island imports must be NAMED imports (a named \`{ ${tag} }\` import; default/namespace imports aren't supported as islands).`,
        );
      }
      const name = imp.imported; // = the component's runtime name = the marker the JSX runtime stamps
      // Re-base a relative specifier from the importing file to appDir (the gen
      // file lives in appDir); a package specifier is used verbatim.
      const loaderSpec = imp.spec.startsWith(".")
        ? "./" + relative(appDir, resolve(dirname(f), imp.spec))
        : imp.spec;

      const prev = seen.get(name);
      if (prev && prev !== loaderSpec) {
        throw new Error(
          `[june] duplicate island name "${name}" from different modules ("${prev}" and "${loaderSpec}"). Island names must be unique.`,
        );
      }
      if (seen.has(name)) continue; // same island used on several pages — fine
      seen.set(name, loaderSpec);
      entries.push(
        `  ${JSON.stringify(name)}: () => import(${JSON.stringify(loaderSpec)}).then((m) => m.${name}),`,
      );
    }
  }

  entries.sort(); // deterministic output
  const body = entries.length ? entries.join("\n") + "\n" : "";
  const out =
    "// AUTO-GENERATED by June — do not edit. Lazy loaders for client:* islands.\n" +
    "// Maps each island name to a loader that resolves its component; hydrateIslands uses it.\n" +
    "export const ISLAND_LOADERS: Record<string, () => Promise<unknown>> = {\n" +
    body +
    "};\n";
  writeFileSync(join(appDir, ISLAND_REGISTRY_FILE), out);
  return entries.length;
}
