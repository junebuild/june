// jsxTransform / appJsxImportSource: both bundle passes (worker + client) skip the explicit
// transform.jsx.importSource when the app tsconfig already declares "@junejs/core" — otherwise
// rolldown emits CONFIGURATION_FIELD_CONFLICT even for the SAME value. The reader must be
// JSONC-tolerant (comments + trailing commas are idiomatic tsconfig) — a strict-parse failure
// silently regressed to "not declared", which is exactly how the warning came back.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appJsxImportSource, jsxTransform } from "../src/tsconfig-jsx";
import { isExpectedClientLog } from "../src/client-bundle";

const roots: string[] = [];
function app(tsconfig?: string, extra?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "june-tsx-"));
  roots.push(root);
  if (tsconfig !== undefined) writeFileSync(join(root, "tsconfig.json"), tsconfig);
  extra?.(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("appJsxImportSource", () => {
  test("reads a directly-declared jsxImportSource", async () => {
    const root = app(`{ "compilerOptions": { "jsxImportSource": "@junejs/core" } }`);
    expect(await appJsxImportSource(root)).toBe("@junejs/core");
  });

  test("tolerates JSONC — comments and trailing commas (the kura template shape)", async () => {
    const root = app(
      `{\n` +
        `  // editors type-check JSX against June's runtime\n` +
        `  "compilerOptions": {\n` +
        `    /* island JSX */ "jsxImportSource": "@junejs/core",\n` +
        `  },\n` +
        `}\n`,
    );
    expect(await appJsxImportSource(root)).toBe("@junejs/core");
  });

  test("a URL in a string survives comment-stripping", async () => {
    const root = app(`{ "compilerOptions": { "jsxImportSource": "@junejs/core", "paths": { "x": ["https://irrelevant"] } } }`);
    expect(await appJsxImportSource(root)).toBe("@junejs/core");
  });

  test("follows one level of extends — relative and bare (node_modules) specifiers", async () => {
    const rel = app(`{ "extends": "./base.json" }`, (root) => {
      writeFileSync(join(root, "base.json"), `{ "compilerOptions": { "jsxImportSource": "@junejs/core" } }`);
    });
    expect(await appJsxImportSource(rel)).toBe("@junejs/core");
    const bare = app(`{ "extends": "@kurajs/docs/tsconfig.kura.json" }`, (root) => {
      mkdirSync(join(root, "node_modules", "@kurajs", "docs"), { recursive: true });
      writeFileSync(
        join(root, "node_modules", "@kurajs", "docs", "tsconfig.kura.json"),
        `{ "compilerOptions": { "jsxImportSource": "@junejs/core" } }`,
      );
    });
    expect(await appJsxImportSource(bare)).toBe("@junejs/core");
  });

  test("absent / unreadable / undeclared → undefined", async () => {
    expect(await appJsxImportSource(app())).toBeUndefined(); // no tsconfig at all
    expect(await appJsxImportSource(app(`{not json`))).toBeUndefined();
    expect(await appJsxImportSource(app(`{ "compilerOptions": { "strict": true } }`))).toBeUndefined();
  });
});

describe("jsxTransform", () => {
  test("tsconfig declares @junejs/core → NO explicit importSource (rolldown reads tsconfig silently)", async () => {
    const root = app(`{ "compilerOptions": { "jsxImportSource": "@junejs/core" } }`);
    expect(await jsxTransform(root)).toEqual({ runtime: "automatic" });
  });

  test("no tsconfig / different value → the explicit importSource IS set", async () => {
    expect(await jsxTransform(app())).toEqual({ runtime: "automatic", importSource: "@junejs/core" });
    const react = app(`{ "compilerOptions": { "jsxImportSource": "react" } }`);
    expect(await jsxTransform(react)).toEqual({ runtime: "automatic", importSource: "@junejs/core" });
  });
});

describe("isExpectedClientLog (client-bundle noise filter)", () => {
  test("silences ONLY the intentional react-server-dom-webpack optional import", () => {
    expect(isExpectedClientLog({ code: "UNRESOLVED_IMPORT", exporter: "react-server-dom-webpack/client.browser" })).toBe(true);
    expect(isExpectedClientLog({ code: "UNRESOLVED_IMPORT", exporter: "react-server-dom-webpack" })).toBe(true);
  });

  test("every other log still surfaces", () => {
    expect(isExpectedClientLog({ code: "UNRESOLVED_IMPORT", exporter: "some-missing-pkg" })).toBe(false); // a REAL missing dep
    expect(isExpectedClientLog({ code: "UNRESOLVED_IMPORT" })).toBe(false);
    expect(isExpectedClientLog({ code: "CONFIGURATION_FIELD_CONFLICT", exporter: "react-server-dom-webpack" })).toBe(false);
    expect(isExpectedClientLog({})).toBe(false);
  });
});
