// Resource resolution — open the handles declared in june.config.ts `resources`
// and hand them to the pipeline, which injects them onto RouteContext (ctx.db /
// ctx.kv / ctx.blob). A resource not declared is never opened (and, for static
// apps, tree-shaken out — the build freeze knows which routes touch resources).

import type { ResourceConfig, Resources } from "junecore/resources";

// Open every declared resource once. Returns a memoized provider so the same
// long-lived handles are reused across requests (one SQLite connection, etc.).
export function memoizeResources(
  config?: ResourceConfig,
): () => Promise<Resources> {
  if (!config || (!config.db && !config.kv && !config.blob)) {
    const empty: Resources = {};
    return () => Promise.resolve(empty);
  }
  let opened: Promise<Resources> | null = null;
  return () => {
    if (!opened) {
      opened = (async () => ({
        db: config.db ? await config.db.open() : undefined,
        kv: config.kv ? await config.kv.open() : undefined,
        blob: config.blob ? await config.blob.open() : undefined,
      }))();
    }
    return opened;
  };
}
