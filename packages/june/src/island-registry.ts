// Auto-generate the island registry by scanning "use client" island() modules,
// so the author never hand-writes the `{ name: () => import("./Island") }` map.
//
// Scans app/** for modules that (a) start with the "use client" directive AND
// (b) use `island()` from @junejs/core/islands, and writes app/_islands.gen.ts:
//
//   export const ISLAND_LOADERS = {
//     "Counter": () => import("./poc/Counter"),
//     "Tabs":    () => import("./poc/Tabs"),
//   };
//
// The KEY is the module's EXPORT name; importing the module runs its `island()`
// call, which self-registers the component under its runtime name. Those must
// agree — the marker the server stamps (the island's name) is what the client
// looks up. So the convention is: an island's name == its export name (the React
// default — `export const Counter = island(function Counter() {…})` satisfies it
// for free; otherwise pass `island(C, { name })`).
//
// Over-inclusion is harmless: a loader whose name no marker references is never
// called, so no chunk for an unused export is ever fetched.
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
// Keying the loader by THIS (not the export name) is what kills the desync
// (P1-1): the marker, the registry, and the loader all agree by construction.
// Returns null for an anonymous component with no { name } — island() throws on
// that at runtime, so we leave it for the runtime to report.
function islandNameOfCall(init: unknown): string | null {
  const call = init as { type?: string; callee?: { type?: string; name?: string }; arguments?: any[] };
  if (call?.type !== "CallExpression") return null;
  if (call.callee?.type !== "Identifier" || call.callee.name !== "island") return null;
  const [a0, a1] = call.arguments ?? [];
  if (a1?.type === "ObjectExpression") {
    for (const p of a1.properties ?? []) {
      const key = p.key?.name ?? p.key?.value;
      if (key === "name" && typeof p.value?.value === "string") return p.value.value;
    }
  }
  if (a0?.type === "FunctionExpression") return a0.id?.name ?? null;
  if (a0?.type === "Identifier") return a0.name ?? null;
  return null; // arrow/anonymous without { name } → runtime island() errors
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
    if (!/\.(tsx|ts|jsx)$/.test(f) || f.endsWith(ISLAND_REGISTRY_FILE)) continue;
    const src = readFileSync(f, "utf8");
    if (!firstStatementIsDirective(src, "use client")) continue;
    const { program } = parseSync(f, src);
    if (!importsIslandApi(program as { body: any[] })) continue;

    const rel = "./" + relative(appDir, f).replace(/\.(tsx|ts|jsx)$/, "");
    for (const node of (program as { body: any[] }).body) {
      const varDecl =
        node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration"
          ? node.declaration
          : node.type === "VariableDeclaration"
            ? node
            : null;
      if (!varDecl) continue;
      for (const d of varDecl.declarations ?? []) {
        const name = islandNameOfCall(d.init);
        if (!name) continue;
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
