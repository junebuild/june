// #94: the server↔core contract assert — a nested second copy of @junejs/core
// (regular-dep version skew) must fail at POWER-ON with both versions named,
// not mid-turn with "sink.emit is not a function". The peerDependency is the
// primary fix; this is the belt-and-braces for trees where nesting still happens.

import { describe, expect, test } from "bun:test";
import { assertCoreRuntimeVersion, checkCoreRuntimeVersion } from "../src/core-version";
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
