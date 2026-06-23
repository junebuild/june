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
// KNOWN EDGE (N4): the marker name the JSX runtime stamps is the component's runtime
// `.name`; this key is the IMPORTED name. They agree when the export name == the
// function name (the norm). A renamed export (`export { Foo as Counter }`, or
// `export const Counter = someFn`) makes them differ → the marker can't find its
// loader → the island stays inert and `hydrateIslands` warns. We can't read the
// runtime name statically, so this is a documented edge, not a build error.
//
// Host-coupled (node:fs + oxc-parser), so it lives in @junejs/server.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
// A usage with children is a SLOT island (handled at runtime); the loader is the
// same either way, so the codegen only needs the tags.
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

// Resolve a relative import specifier to a source file on disk (try extensions +
// /index), or null if it can't be resolved (path alias / virtual / package).
function resolveLocalModule(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const exts = [".tsx", ".ts", ".jsx", ".js"];
  for (const e of exts) if (existsSync(base + e)) return base + e;
  for (const e of exts) if (existsSync(join(base, "index" + e))) return join(base, "index" + e);
  return null;
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
      const isRelative = imp.spec.startsWith(".");
      const loaderSpec = isRelative ? "./" + relative(appDir, resolve(dirname(f), imp.spec)) : imp.spec;

      // N3: an island runs on the client, so its module must be a client module —
      // otherwise its loader would pull a server-only graph (node:*, secrets) into
      // the client bundle. Verify "use client" for modules we can resolve on disk
      // (relative imports); package islands are trusted (can't reliably resolve).
      if (isRelative) {
        const modFile = resolveLocalModule(f, imp.spec);
        if (modFile && !firstStatementIsDirective(readFileSync(modFile, "utf8"), "use client")) {
          throw new Error(
            `[june] island "${name}" (./${relative(appDir, modFile)}) is used with client:* but its module is not "use client". An island must be a client module.`,
          );
        }
      }

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
