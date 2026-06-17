// `june gen` for ICU messages — OPT-IN: only an app that has a `messages/` dir
// AND `@junejs/i18n` installed gets a generated `app/_messages.ts` (the compiled
// catalogs + the typed `t`). The codegen is dynamically imported so the CLI never
// hard-depends on the opt-in package — same seam as a data layer.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The structural shape of @junejs/i18n/codegen (avoids a CLI → i18n type dep).
type Codegen = {
  generateMessagesModule: (
    dir: string,
    opts: { defaultLocale: string },
  ) => { code: string; locales: string[] };
};

/** Generate `app/_messages.ts` from `messages/*.json`. Returns the locales, or
 *  null when there's no `messages/` dir or @junejs/i18n isn't installed. */
export async function generateMessages(root: string): Promise<string[] | null> {
  const messagesDir = join(root, "messages");
  if (!existsSync(messagesDir)) return null;

  let codegen: Codegen;
  try {
    // Resolve from the APP's deps (where it's installed), not the CLI's own
    // node_modules — the CLI doesn't depend on the opt-in package. createRequire
    // rooted at the app + import the resolved path.
    // createRequire needs an absolute referencing path.
    const resolved = createRequire(resolve(root, "package.json")).resolve("@junejs/i18n/codegen");
    codegen = (await import(pathToFileURL(resolved).href)) as Codegen;
  } catch {
    console.warn(
      "[june] messages/ found but @junejs/i18n is not installed — skipping " +
        "(run: bun add @junejs/i18n)",
    );
    return null;
  }

  const { loadJuneConfig } = await import("@junejs/server");
  const config = await loadJuneConfig(root);
  const defaultLocale = config.i18n?.defaultLocale ?? "en";
  const { code, locales } = codegen.generateMessagesModule(messagesDir, { defaultLocale });
  await writeFile(join(root, "app", "_messages.ts"), code);
  return locales;
}
