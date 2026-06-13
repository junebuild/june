// agent.ts — the unified action registry.
//
// One `defineAction()` entry is the single source of truth: it is the UI server
// action, the MCP tool at /mcp, AND the browser WebMCP tool — all invoked by the
// same id against this one registry. The RSC server-action path registers into
// THIS registry too, so a server action and an MCP tool are no longer "the same
// thing described twice."
//
//   1. defineAction(): id + description + input schema + run.
//   2. invokeAction(id, input): the JSON dispatch path (MCP). RSC's Flight
//      dispatch resolves the same registry.

import { currentTrace } from "./instrumentation";
import type { ActionContext } from "./context";

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
};

export type ActionDefinition<I = unknown, O = unknown> = {
  id: string;
  description: string;
  input: JsonSchema;
  // run() receives the request-scoped IDENTITY (principal/session) as its second
  // arg, so the SAME authorization runs on the UI and /mcp paths. Data is the
  // ambient `db`/`kv`/`blob`, not on ctx. An action that ignores ctx (one-param
  // run) is still assignable here.
  run: (input: I, ctx: ActionContext) => O | Promise<O>;
};

// `ActionDefinition` is invariant in its input type (the `run` param), so a
// concretely-typed action is not assignable to `ActionDefinition<unknown>`.
// Collections of heterogeneous actions use this loose alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAction = ActionDefinition<any, any>;

// The single, unified action registry — keyed on globalThis so any dispatch
// path (agent POST, MCP tools/call, RSC Flight) resolves an action by id even
// when the resolver loads this module twice (workspace symlinks can give the
// app and the framework different @junejs/core paths; a module-level Map would
// then split registrations across two instances).
const REGISTRY_KEY = Symbol.for("june.actionRegistry");
export const ACTION_REGISTRY: Map<string, AnyAction> = ((
  globalThis as Record<symbol, Map<string, AnyAction> | undefined>
)[REGISTRY_KEY] ??= new Map());

// The RSC runtime (which owns the `react-server` condition) injects how to mark
// a run() as a React server reference, so the SAME action is passable as a UI
// prop without agent.ts importing react-server. No-op outside the RSC runtime.
type ServerReferenceRegistrar = (
  fn: (...args: unknown[]) => unknown,
  id: string,
) => unknown;
let serverReferenceRegistrar: ServerReferenceRegistrar | null = null;
export function setServerReferenceRegistrar(fn: ServerReferenceRegistrar) {
  serverReferenceRegistrar = fn;
}

export function defineAction<I, O>(
  def: ActionDefinition<I, O>,
): ActionDefinition<I, O> {
  ACTION_REGISTRY.set(def.id, def);
  serverReferenceRegistrar?.(def.run as (...args: unknown[]) => unknown, def.id);
  return def;
}

// JSON dispatch path (agent / MCP): invoke an action by id with a single input
// and the request-scoped identity (principal/session). ctx defaults to {} so
// callers that don't have one (tests, anonymous dispatch) still work.
export async function invokeAction(
  id: string,
  input: unknown,
  ctx: ActionContext = {},
): Promise<unknown> {
  const action = ACTION_REGISTRY.get(id);
  if (!action) throw new Error(`Unknown action: ${id}`);
  const result = await action.run(input, ctx);

  // Cache coherence is a property of the ACTION, not of one dispatch path:
  // every table this action wrote invalidates its `table:<name>` tag (plus the
  // coarse `flight` tag), no matter how it was invoked — UI POST, /mcp
  // tools/call, or Flight. (Idempotent if a caller also invalidates.)
  const writes = currentTrace()?.writes;
  if (writes && writes.size > 0) {
    const { invalidate } = await import("./cache");
    for (const table of writes) await invalidate(`table:${table}`);
    await invalidate("flight");
  }

  return result;
}
