// The host side of request tracing. @junejs/core's instrumentation is pure and
// host-free — it exposes `installTraceContext(provider)` and otherwise no-ops.
// This module supplies the provider: node:async_hooks' AsyncLocalStorage,
// loaded LAZILY through a non-literal specifier so no bundler resolves `node:*`
// (workerd assets-mode registers chunks raw — a static import would break
// module registration even on a path that never runs there). See rebuild-plan
// reminders #1 and #4.
//
// Hosts that lack async_hooks simply never call this; @junejs/core then runs
// untraced and every recorder degrades to a no-op — requests still serve.

import { installTraceContext, type RequestTrace } from "@junejs/core/instrumentation";

let installed = false;

export async function installAsyncContext(): Promise<boolean> {
  if (installed) return true;
  try {
    const specifier = "node:async_hooks";
    const mod = (await import(specifier)) as {
      AsyncLocalStorage: new () => {
        getStore(): RequestTrace | undefined;
        run<R>(store: RequestTrace, fn: () => R): R;
      };
    };
    installTraceContext(new mod.AsyncLocalStorage());
    installed = true;
    return true;
  } catch {
    // No async context on this host — tracing stays disabled.
    return false;
  }
}
