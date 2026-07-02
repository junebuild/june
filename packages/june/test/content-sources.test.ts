// generateContent + config `content.sources`: the docs-as-code seam. Covers the config-driven
// happy path AND the bootstrap two-pass — a wrapper-generated config (Kura's) imports
// app/_content.ts, which doesn't exist before the FIRST freeze; generateContent must self-heal
// (default scan → retry config → regenerate with sources) instead of failing or silently
// dropping the configured sources.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateContent } from "../src/build";

const md = (title: string, date: string) => `---\ntitle: ${title}\ndate: ${date}\n---\n# ${title}\n`;

// A minimal June app root: app/ (for the generated _content.ts), content/docs/, and an
// external sibling source dir. Each test gets its OWN root so config-module caching in this
// process can't leak between tests (loadJuneConfig caches by file URL).
function makeApp(): string {
  const root = mkdtempSync(join(tmpdir(), "june-gen-src-"));
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, "content", "docs"), { recursive: true });
  writeFileSync(join(root, "content", "docs", "intro.md"), md("Intro", "2026-01-01"));
  mkdirSync(join(root, "extdocs"), { recursive: true });
  writeFileSync(join(root, "extdocs", "setup.md"), md("Setup", "2026-01-02"));
  return root;
}

describe("generateContent + content.sources", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  test("applies config sources (relative dirs resolve against the app root)", async () => {
    const root = makeApp();
    roots.push(root);
    writeFileSync(
      join(root, "june.config.ts"),
      `export default { content: { sources: [{ dir: "extdocs", collection: "docs", mount: "ext" }] } };\n`,
    );
    const names = await generateContent(root);
    expect(names).toEqual(["docs"]);
    const out = readFileSync(join(root, "app", "_content.ts"), "utf8");
    expect(out).toContain('"slug": "intro"'); // content/docs still there
    expect(out).toContain('"slug": "ext/setup"'); // external source, mount-prefixed
  });

  test("no content config → exactly the default scan (zero regression)", async () => {
    const root = makeApp();
    roots.push(root);
    writeFileSync(join(root, "june.config.ts"), `export default { site: { name: "t" } };\n`);
    expect(await generateContent(root)).toEqual(["docs"]);
    const out = readFileSync(join(root, "app", "_content.ts"), "utf8");
    expect(out).toContain('"slug": "intro"');
    expect(out).not.toContain("setup"); // extdocs not configured → not scanned
  });

  test("BOOTSTRAP: a config importing app/_content.ts (not yet generated) self-heals and applies sources", async () => {
    const root = makeApp();
    roots.push(root);
    // The Kura shape: a generated .june/config.ts whose import graph needs app/_content.ts —
    // which only exists AFTER generateContent runs. First load fails; the two-pass must
    // generate the default scan, retry the config (cache-busted), and regenerate with sources.
    mkdirSync(join(root, ".june"), { recursive: true });
    writeFileSync(
      join(root, ".june", "config.ts"),
      `import { DOCS } from "../app/_content";\n` +
        `export default { site: { name: \`n\${DOCS.length}\` }, content: { sources: [{ dir: "extdocs", collection: "docs" }] } };\n`,
    );
    const names = await generateContent(root);
    expect(names).toEqual(["docs"]);
    const out = readFileSync(join(root, "app", "_content.ts"), "utf8");
    expect(out).toContain('"slug": "intro"');
    expect(out).toContain('"slug": "setup"'); // the sources survived the bootstrap
  });

  test("a broken config (not the bootstrap case) degrades to the default scan with a warning, not a crash", async () => {
    const root = makeApp();
    roots.push(root);
    writeFileSync(join(root, "june.config.ts"), `throw new Error("boom");\nexport default {};\n`);
    const names = await generateContent(root);
    expect(names).toEqual(["docs"]); // default scan still generated
    const out = readFileSync(join(root, "app", "_content.ts"), "utf8");
    expect(out).toContain('"slug": "intro"');
  });
});

// Locale buckets are DECLARED (config i18n), not guessed by folder shape. The old BCP-47 regex
// swallowed ANY 2–3-letter top-level folder — content/docs/cli/ read as a locale and its pages
// silently vanished from the default set.
describe("generateContent + declared locales", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  // content/docs with common short section folders AND a real de/ mirror
  function makeI18nApp(config: string): string {
    const root = mkdtempSync(join(tmpdir(), "june-gen-loc-"));
    roots.push(root);
    mkdirSync(join(root, "app"), { recursive: true });
    for (const dir of ["cli", "sdk", "api", join("de", "cli")]) {
      mkdirSync(join(root, "content", "docs", dir), { recursive: true });
    }
    writeFileSync(join(root, "content", "docs", "cli", "usage.md"), md("CLI", "2026-01-01"));
    writeFileSync(join(root, "content", "docs", "sdk", "install.md"), md("SDK", "2026-01-02"));
    writeFileSync(join(root, "content", "docs", "api", "auth.md"), md("API", "2026-01-03"));
    writeFileSync(join(root, "content", "docs", "de", "cli", "usage.md"), md("CLI DE", "2026-01-01"));
    writeFileSync(join(root, "june.config.ts"), config);
    return root;
  }

  test("THE BUG: cli/sdk/api sections are CONTENT, not locales — only declared i18n dirs bucket", async () => {
    const root = makeI18nApp(
      `export default { i18n: { defaultLocale: "en", locales: { en: {}, de: {} } } };\n`,
    );
    await generateContent(root);
    const out = readFileSync(join(root, "app", "_content.ts"), "utf8");
    for (const slug of ["cli/usage", "sdk/install", "api/auth"]) {
      expect(out).toContain(`"slug": "${slug}"`); // sections survive
    }
    expect(out).toContain("DOCS_L"); // de/ is a bucket (declared)
    expect(out).toContain('"CLI DE"');
  });

  test("no i18n config → NO locale buckets at all (an undeclared locale is not a locale)", async () => {
    const root = makeI18nApp(`export default { site: { name: "t" } };\n`);
    await generateContent(root);
    const out = readFileSync(join(root, "app", "_content.ts"), "utf8");
    expect(out).toContain('"slug": "de/cli/usage"'); // de/ is plain content now
    expect(out).not.toContain("DOCS_L");
  });

  test("bootstrap two-pass carries the declared locales (not just sources)", async () => {
    const root = makeI18nApp(""); // placeholder, replaced below with a config that needs _content.ts
    rmSync(join(root, "june.config.ts"));
    mkdirSync(join(root, ".june"), { recursive: true });
    writeFileSync(
      join(root, ".june", "config.ts"),
      `import { DOCS } from "../app/_content";\n` +
        `export default { site: { name: \`n\${DOCS.length}\` }, i18n: { defaultLocale: "en", locales: { en: {}, de: {} } } };\n`,
    );
    await generateContent(root);
    const out = readFileSync(join(root, "app", "_content.ts"), "utf8");
    expect(out).toContain('"slug": "cli/usage"'); // pass 2 applied declared locales: cli is content…
    expect(out).toContain("DOCS_L"); // …and de is a bucket
  });
});
