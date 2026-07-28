// #94: the server↔core contract assert — a nested second copy of @junejs/core
// (regular-dep version skew) must fail at POWER-ON with both versions named,
// not mid-turn with "sink.emit is not a function". The peerDependency is the
// primary fix; this is the belt-and-braces for trees where nesting still happens.

import { describe, expect, test } from "bun:test";
import { assertCoreRuntimeVersion, checkCoreRuntimeVersion } from "../src/core-version";
import { isolateLocal, makeIsolateLocalFallback } from "../src/isolate-local";
import { RUNTIME_API_VERSION } from "@junejs/core/agent-runtime";

describe("core runtime version assert (#94)", () => {
  test("the workspace's own core matches — construction-time assert passes", () => {
    expect(() => assertCoreRuntimeVersion("NativeRuntime")).not.toThrow();
  });

  test("a pre-#94 core (no RUNTIME_API_VERSION export) is named as such", () => {
    expect(() => checkCoreRuntimeVersion("AgentDurableObject(ops)", undefined)).toThrow(
      /AgentDurableObject\(ops\): .*built against @junejs\/core runtime API v\d+.*no RUNTIME_API_VERSION \(a pre-0\.1\.1-dev\.16 core\).*two copies/,
    );
  });

  test("a mismatched core names BOTH versions", () => {
    expect(() => checkCoreRuntimeVersion("NativeRuntime", 1, 2)).toThrow(
      /built against @junejs\/core runtime API v2.*provides v1/,
    );
  });

  test("the expected number tracks core's actual export — bump them in lockstep", () => {
    // If core's RUNTIME_API_VERSION is bumped without the server's expected number
    // (or vice versa), every construction in this tree throws — this test makes the
    // lockstep rule fail loudly in CI instead.
    expect(() => checkCoreRuntimeVersion("lockstep", RUNTIME_API_VERSION)).not.toThrow();
  });
});

// The isolateLocal optional read (see isolate-local.ts): a named import of an
// export an older @junejs/db lacks would die at module link time, so the read is
// a namespace lookup with a local fallback. The ambient read can only ever see
// the workspace's own (matching) db, so the degraded path is tested directly.
describe("isolateLocal fallback (older @junejs/db)", () => {
  test("memoizes per key, so a caller's cache still works", () => {
    const fallback = makeIsolateLocalFallback();
    let made = 0;
    const make = () => (made++, new Map<string, number>());

    const a = fallback("k", make);
    a.set("hits", 1);

    expect(fallback("k", make)).toBe(a);
    expect(fallback("k", make).get("hits")).toBe(1);
    expect(made).toBe(1);
    expect(fallback("other", make)).not.toBe(a);
  });

  test("the resolved export is used when the db provides it", () => {
    // Workspace db has it, so this is the real one — not the fallback.
    expect(typeof isolateLocal).toBe("function");
    const shared = isolateLocal("test.june.resolved", () => ({ ok: true }));
    expect(isolateLocal("test.june.resolved", () => ({ ok: false }))).toBe(shared);
  });
});
