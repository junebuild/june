// The build codegen: messages/*.json → compiled catalogs (runtime, via
// loadMessages) + the generated module with a TYPED `t` (structure).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTranslator } from "../src/index";
import { generateMessagesModule, loadMessages } from "../src/codegen";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "june-messages-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "en.json"),
    JSON.stringify({ hi: "Hello, {name}!", items: "{n, plural, one {# item} other {# items}}", bye: "Bye" }),
  );
  writeFileSync(join(dir, "de.json"), JSON.stringify({ hi: "Hallo, {name}!" }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadMessages — compile the catalogs (runtime path)", () => {
  test("compiles each locale and formats correctly", () => {
    const { catalogs, locales } = loadMessages(dir);
    expect(locales.sort()).toEqual(["de", "en"]);
    const t = createTranslator("en", catalogs, "en");
    expect(t("hi", { name: "Ada" })).toBe("Hello, Ada!");
    expect(t("items", { n: 3 })).toBe("3 items"); // plural, compiled
    // de falls back to en for an untranslated key
    expect(createTranslator("de", catalogs, "en")("bye")).toBe("Bye");
  });
});

describe("generateMessagesModule — the typed-t module", () => {
  test("emits defineMessages + a Messages type derived from the ICU ASTs", () => {
    const { code, locales } = generateMessagesModule(dir, { defaultLocale: "en" });
    expect(locales.sort()).toEqual(["de", "en"]);
    expect(code).toContain("defineMessages(CATALOGS, { defaultLocale: \"en\" })");
    // params typed from the AST: {name} → string, plural var → number, none → never
    expect(code).toContain('"hi": { "name": string };');
    expect(code).toContain('"items": { "n": number };');
    expect(code).toContain('"bye": Record<never, never>;');
    // the typed t signature (no-param keys take no args; others require params)
    expect(code).toContain("export const t = rawT as <K extends keyof Messages>");
    expect(code).toContain("keyof Messages[K] extends never ? [] : [params: Messages[K]]");
  });
});
