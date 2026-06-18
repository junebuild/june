// Regression: the worker bundle must externalize Bun built-ins. @junejs/core's redis() cache store
// guards a Bun-only module behind `const x = "bun"; await import(x)`; rolldown constant-folds that and
// would warn UNRESOLVED_IMPORT (and could try to pull a Bun-only module into the workerd graph) unless
// the build declares `bun`/`bun:*` external. isBunSpecifier is that rule.
import { describe, expect, test } from "bun:test";
import { isBunSpecifier } from "../src/build";

describe("isBunSpecifier (worker-bundle externals)", () => {
  test("treats the bun namespace as external", () => {
    expect(isBunSpecifier("bun")).toBe(true);
    expect(isBunSpecifier("bun:sqlite")).toBe(true);
    expect(isBunSpecifier("bun:ffi")).toBe(true);
  });

  test("leaves normal modules bundleable", () => {
    expect(isBunSpecifier("react")).toBe(false);
    expect(isBunSpecifier("@junejs/core")).toBe(false);
    expect(isBunSpecifier("node:fs")).toBe(false);
    // not the bun namespace — must NOT be swallowed by a loose prefix match
    expect(isBunSpecifier("bundle")).toBe(false);
    expect(isBunSpecifier("bunny")).toBe(false);
  });
});
