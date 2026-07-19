// core-version.ts — the #94 belt-and-braces: fail at POWER-ON when the @junejs/core
// copy this server resolved is not the one it was built for.
//
// The primary fix is @junejs/core being a peerDependency (the app's single resolution
// always wins), but a nested second copy can still appear (npm legacy peer handling,
// a stale lockfile, a transitive pin). When it does, the failure without this check
// is far from the cause and mid-turn ("sink.emit is not a function", first seen in
// crisp-agent production); with it, construction throws with both versions named.
//
// Namespace import + optional read on purpose: a PRE-#94 core has no
// RUNTIME_API_VERSION export, and a named import of a missing export would die at
// module link time with an unhelpful SyntaxError — exactly the confusion this
// module exists to remove.
import * as coreRuntime from "@junejs/core/agent-runtime";

// The contract number this server tree is built against. Bump in lockstep with
// core's RUNTIME_API_VERSION whenever the server↔core runtime contract changes.
const EXPECTED_CORE_RUNTIME_API = 1;

export function assertCoreRuntimeVersion(surface: string): void {
  checkCoreRuntimeVersion(surface, (coreRuntime as { RUNTIME_API_VERSION?: number }).RUNTIME_API_VERSION);
}

// The pure check, split out so the mismatch paths are unit-testable (the ambient
// read above can only ever see the workspace's own — matching — core).
export function checkCoreRuntimeVersion(surface: string, actual: number | undefined, expected: number = EXPECTED_CORE_RUNTIME_API): void {
  if (actual === expected) return;
  throw new Error(
    `${surface}: @junejs/server is built against @junejs/core runtime API v${expected}, ` +
      `but the @junejs/core it resolved provides ${actual === undefined ? "no RUNTIME_API_VERSION (a pre-0.1.1-dev.16 core)" : `v${actual}`} — ` +
      `two copies of @junejs/core are likely installed (one nested under @junejs/server). ` +
      `Align the app's @junejs/core with @junejs/server's peer range, then reinstall/dedupe so one copy remains.`,
  );
}
