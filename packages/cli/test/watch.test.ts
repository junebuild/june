import { describe, expect, test } from "bun:test";

import { ignoredPath } from "../src/watch";

describe("ignoredPath()", () => {
  test("app code, content, and config trigger a restart", () => {
    expect(ignoredPath("app/page.tsx")).toBe(false);
    expect(ignoredPath("app/docs/layout.tsx")).toBe(false);
    expect(ignoredPath("content/posts/hello.md")).toBe(false);
    expect(ignoredPath("june.config.ts")).toBe(false);
  });

  test("generated and vendored paths never trigger (no restart loops)", () => {
    expect(ignoredPath("app/_content.ts")).toBe(true); // written by `june gen`
    expect(ignoredPath("node_modules/react/index.js")).toBe(true);
    expect(ignoredPath("dist/worker.js")).toBe(true);
    expect(ignoredPath(".git/HEAD")).toBe(true);
    expect(ignoredPath(".june/blob/x")).toBe(true);
  });

  test("stylesheets are ignored — CSS HMR hot-swaps them, a restart would full-reload", () => {
    expect(ignoredPath("app/global.css")).toBe(true);
    expect(ignoredPath("app/components/card.module.css")).toBe(true);
    expect(ignoredPath("app/page.tsx")).toBe(false); // code still restarts
  });

  test("an _content-named file deeper than app/ still triggers", () => {
    expect(ignoredPath("app/docs/_content.ts")).toBe(false);
  });
});
