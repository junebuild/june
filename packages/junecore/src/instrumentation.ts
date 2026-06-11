// Request tracing — timings + the table read/write sets that drive automatic
// cache tagging. Lives in the PURE contract layer, so it carries NO `node:*`
// import: the async-context provider (node:async_hooks AsyncLocalStorage on
// Bun/Node, or workerd's nodejs_compat equivalent) is INJECTED by the host via
// `installTraceContext()`. Hosts that never install one run untraced — every
// recorder degrades to a no-op, requests still serve.
//
// (In the PoC this module did a top-level `await import("node:async_hooks")`,
// which forced every bundle reaching it to register a node:* specifier — the
// exact failure mode that breaks workerd assets-mode. Inverting the dependency
// keeps the layer host-free; see docs/rebuild-plan.md reminders #1 and #4.)

// The minimal slice of AsyncLocalStorage the trace machinery needs. A host
// installs a concrete implementation; the type stays structural so this layer
// never names a runtime.
export type AsyncContext<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

export type TimingKind = "db" | "page" | "route" | "rsc" | "view" | "cache";

export type TimingEvent = {
  kind: TimingKind;
  label: string;
  durationMs: number;
  detail?: string;
};

export type RequestTrace = {
  id: string;
  startedAt: number;
  events: TimingEvent[];
  // Tables touched this request — for automatic cache tagging/invalidation.
  reads?: Set<string>;
  writes?: Set<string>;
};

let traces: AsyncContext<RequestTrace> | null = null;

// Host seam: install the async-context provider once at startup. The Bun/Node
// hosts pass `new (await import("node:async_hooks")).AsyncLocalStorage()`.
export function installTraceContext(context: AsyncContext<RequestTrace>) {
  traces = context;
}

// True once a host has wired a provider — useful for hosts deciding whether to
// bother constructing a trace at all.
export function tracingEnabled(): boolean {
  return traces !== null;
}

function ms(value: number) {
  return value.toFixed(1);
}

function prefix(trace: RequestTrace) {
  return `[${trace.id.slice(0, 8)}]`;
}

export function currentTrace() {
  return traces?.getStore();
}

export function runWithTrace<T>(trace: RequestTrace, fn: () => T) {
  return traces ? traces.run(trace, fn) : fn();
}

// The data layer records every table it reads/writes, so the cache layer can
// derive tags automatically instead of relying on hand-declared ones.
export function recordTableRead(table: string) {
  const trace = currentTrace();
  if (trace) (trace.reads ??= new Set()).add(table);
}

export function recordTableWrite(table: string) {
  const trace = currentTrace();
  if (trace) (trace.writes ??= new Set()).add(table);
}

export function recordTiming(
  kind: TimingKind,
  label: string,
  durationMs: number,
  detail?: string,
) {
  const trace = currentTrace();
  if (!trace) return;

  trace.events.push({ kind, label, durationMs, detail });

  if (kind === "db") {
    const suffix = detail ? ` ${detail}` : "";
    console.log(`${prefix(trace)}   SQL (${ms(durationMs)}ms)${suffix}`);
  } else if (kind === "cache") {
    console.log(`${prefix(trace)}   CACHE ${label}${detail ? ` ${detail}` : ""}`);
  }
}

export async function measure<T>(
  kind: TimingKind,
  label: string,
  fn: () => T | Promise<T>,
  detail?: string,
) {
  const startedAt = performance.now();

  try {
    return await fn();
  } finally {
    recordTiming(kind, label, performance.now() - startedAt, detail);
  }
}

export function timingTotal(trace: RequestTrace, kind: TimingKind) {
  return trace.events
    .filter((event) => event.kind === kind)
    .reduce((total, event) => total + event.durationMs, 0);
}

export function requestDuration(trace: RequestTrace) {
  return performance.now() - trace.startedAt;
}

export function timingSummary(trace: RequestTrace) {
  const page = timingTotal(trace, "page");
  const rsc = timingTotal(trace, "rsc");
  const view = timingTotal(trace, "view");
  const db = timingTotal(trace, "db");
  const render = rsc > 0 ? `RSC: ${ms(rsc)}ms` : `Views: ${ms(view)}ms`;

  return `Page: ${ms(page)}ms | ${render} | DB: ${ms(db)}ms`;
}

export function logStarted(request: Request, trace: RequestTrace) {
  const url = new URL(request.url);
  const forwardedFor = request.headers.get("x-forwarded-for");
  const remote = forwardedFor?.split(",")[0]?.trim() || "unknown";

  console.log(
    `${prefix(trace)} Started ${request.method} "${url.pathname}${url.search}" for ${remote} at ${new Date().toISOString()}`,
  );
}

export function logProcessing(routeFile: string) {
  const trace = currentTrace();
  if (!trace) return;

  console.log(`${prefix(trace)} Processing by ${routeFile}`);
}

export function logCompleted(response: Response, trace: RequestTrace) {
  console.log(
    `${prefix(trace)} Completed ${response.status} ${response.statusText || "OK"} in ${ms(requestDuration(trace))}ms (${timingSummary(trace)})`,
  );
}
