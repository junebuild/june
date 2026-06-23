// Auto-generate the island registry by scanning "use client" island() modules,
// so the author never hand-writes the `{ name: () => import("./Island") }` map.
//
// Scans app/** (AST, via oxc-parser) for modules that (a) start with the
// "use client" directive AND (b) import + call `island()` from @junejs/core/islands,
// and writes app/_islands.gen.ts:
//
//   export const ISLAND_LOADERS = {
//     "Counter": () => import("./Counter"),
//   };
//
// The KEY is the ISLAND name — the value `island()` registers under at runtime
// (options.name, else the wrapped function's/identifier's name), extracted from
// the island() call by islandNameOfCall(). The marker the server stamps, the
// runtime registry, and this loader key therefore all agree BY CONSTRUCTION (no
// export-name desync). Importing the module runs island(), which self-registers
// the component; the loader just triggers that import.
//
// Host-coupled (node:fs), so it lives in @junejs/server, never the contract layer.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

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
// directive — the same rule the bundler uses to treat a module as client.
export function firstStatementIsDirective(src: string, directive: string): boolean {
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    return t.startsWith(`"${directive}"`) || t.startsWith(`'${directive}'`);
  }
  return false;
}

// The named exports of a module (skipping `export default` and `export type`).
export function exportNames(src: string): string[] {
  const names: string[] = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    const decl = t.match(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/);
    if (decl) names.push(decl[1]!);
    const named = t.match(/^export\s*\{([^}]*)\}/); // `export type { … }` won't match (the `type` breaks it)
    if (named) {
      for (const part of named[1]!.split(",")) {
        const e = part.split(" as ").pop()?.trim();
        if (e) names.push(e);
      }
    }
  }
  return names;
}

// The island NAME an `island(...)` call registers under — the SAME value the
// runtime derives (options.name ?? the component's function/identifier name).
// An `island(...)` call (callee is the `island` identifier).
function isIslandCall(init: unknown): boolean {
  const call = init as { type?: string; callee?: { type?: string; name?: string } };
  return call?.type === "CallExpression" && call.callee?.type === "Identifier" && call.callee.name === "island";
}

// The STATIC island name of an island() call: an explicit string-literal { name },
// else the wrapped function's / identifier's name — the SAME value island()
// registers under at runtime, so the marker/registry/loader agree by construction
// (P1-1). Returns null when it can't be determined statically (arrow/anonymous
// with no { name }, or a non-literal { name }) — the caller turns that into a
// build error (R5: fail loud, not a silent skip → dead island).
function islandNameOfCall(init: unknown): string | null {
  const call = init as { arguments?: any[] };
  const [a0, a1] = call.arguments ?? [];
  if (a1?.type === "ObjectExpression") {
    for (const p of a1.properties ?? []) {
      const key = p.key?.name ?? p.key?.value;
      // An explicit { name } wins — but only a string LITERAL is statically known;
      // a dynamic value (the runtime would use it) can't be matched here → null.
      if (key === "name") return typeof p.value?.value === "string" ? p.value.value : null;
    }
  }
  if (a0?.type === "FunctionExpression") return a0.id?.name ?? null;
  if (a0?.type === "Identifier") return a0.name ?? null;
  return null;
}

// True iff the module imports `island` from @junejs/core/islands (so a local
// function happening to be named `island` is never mistaken for the API).
function importsIslandApi(program: { body: any[] }): boolean {
  return program.body.some(
    (n) =>
      n.type === "ImportDeclaration" &&
      n.source?.value === "@junejs/core/islands" &&
      (n.specifiers ?? []).some((s: any) => s.imported?.name === "island"),
  );
}

// True iff "use client" is in the module's directive prologue — read from the AST
// (R5: consistent with the rest of the scan; skips block comments correctly,
// unlike a line regex). The prologue is the run of leading string-literal
// expression statements.
function hasUseClientDirective(program: { body: any[] }): boolean {
  for (const node of program.body) {
    if (node.type !== "ExpressionStatement") break;
    const expr = node.expression;
    if (expr?.type !== "Literal" || typeof expr.value !== "string") break;
    if (expr.value === "use client") return true;
  }
  return false;
}

// Write app/_islands.gen.ts. Returns the number of island loaders emitted.
//
// AST-based (oxc-parser) — robust against multi-line exports / re-exports that a
// line regex would miss (P1-2), keyed by the island's runtime name (P1-1), and
// it throws on a duplicate name across modules (P2-1) instead of silently
// overwriting.
export function generateIslandRegistry(appDir: string): number {
  const seen = new Map<string, string>(); // island name → absolute file (dup guard)
  const entries: string[] = [];

  for (const f of walk(appDir)) {
    if (!/\.(tsx|ts|jsx)$/.test(f) || f.endsWith(ISLAND_REGISTRY_FILE) || f.endsWith(".gen.ts")) continue;
    const src = readFileSync(f, "utf8");
    // Cheap pre-filter: no "use client" substring at all → not a client module
    // (skips every server component without parsing). The AST directive check
    // below is the authoritative one.
    if (!src.includes("use client")) continue;
    const { program } = parseSync(f, src);
    const ast = program as { body: any[] };
    if (!hasUseClientDirective(ast) || !importsIslandApi(ast)) continue;

    const rel = "./" + relative(appDir, f).replace(/\.(tsx|ts|jsx)$/, "");
    for (const node of ast.body) {
      const varDecl =
        node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration"
          ? node.declaration
          : node.type === "VariableDeclaration"
            ? node
            : null;
      if (!varDecl) continue;
      for (const d of varDecl.declarations ?? []) {
        if (!isIslandCall(d.init)) continue;
        const name = islandNameOfCall(d.init);
        if (!name) {
          throw new Error(
            `[june] island() in ${rel} has no statically-determinable name. ` +
              `Name the wrapped function (island(function Counter(){…})) or pass a ` +
              `string-literal island(C, { name: "Counter" }).`,
          );
        }
        const prev = seen.get(name);
        if (prev && prev !== f) {
          throw new Error(
            `[june] duplicate island name "${name}": defined in ${rel} and ` +
              `./${relative(appDir, prev).replace(/\.(tsx|ts|jsx)$/, "")}. Island names must be unique.`,
          );
        }
        if (seen.has(name)) continue;
        seen.set(name, f);
        entries.push(`  ${JSON.stringify(name)}: () => import(${JSON.stringify(rel)}),`);
      }
    }
  }

  entries.sort(); // deterministic output
  const body = entries.length ? entries.join("\n") + "\n" : "";
  const out =
    "// AUTO-GENERATED by June — do not edit. Lazy loaders for island() modules.\n" +
    "// Maps each island name to a lazy chunk loader; hydrateIslandsLazy consumes it.\n" +
    "export const ISLAND_LOADERS: Record<string, () => Promise<unknown>> = {\n" +
    body +
    "};\n";
  writeFileSync(join(appDir, ISLAND_REGISTRY_FILE), out);
  return entries.length;
}
