// isolate-local.ts — read @junejs/db's `isolateLocal` WITHOUT a named import.
//
// Same hazard core-version.ts exists for: a NAMED import of an export the
// resolved copy doesn't have dies at module LINK time with an unhelpful
// SyntaxError, before any of our own diagnostics can run. `isolateLocal` is new
// in @junejs/db 0.1.0-dev.2, and a version range cannot save us here — the
// floor has to stay satisfiable by the workspace's own db (which is the very
// version that lacks it), and `bun pm pack` rewrites a `workspace:*` dep to
// whatever version it resolves, which can be OLDER still.
//
// So: namespace import + optional read, with a local fallback. Unlike the core
// runtime contract, this one does NOT warrant throwing — isolate-scoped
// memoization is a lifetime optimization, not a correctness contract. The
// fallback memoizes in this module instance, so callers keep their cache; the
// only thing lost against an older db is sharing one value across DUPLICATE
// copies of the module (workspace symlinks), which costs a missed cache hit,
// never a wrong answer.
import * as juneDb from "@junejs/db";

export type IsolateLocal = <T>(key: string | symbol, make: () => T) => T;

// Exported for tests: the ambient read below can only ever see the workspace's
// own (matching) db, so the degraded path needs a direct handle to be provable.
export function makeIsolateLocalFallback(): IsolateLocal {
  const values = new Map<string | symbol, unknown>();
  return <T>(key: string | symbol, make: () => T): T => {
    if (!values.has(key)) values.set(key, make());
    return values.get(key) as T;
  };
}

export const isolateLocal: IsolateLocal =
  (juneDb as { isolateLocal?: IsolateLocal }).isolateLocal ?? makeIsolateLocalFallback();
