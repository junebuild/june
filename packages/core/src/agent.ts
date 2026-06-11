// agent.ts — the unified action registry + the agent-facing surface.
//
// One `defineAction()` entry is the single source of truth: it is the UI server
// action, the `.agent` manifest tool, AND the MCP tool — all invoked by the
// same id against this one registry. The RSC server-action path registers into
// THIS registry too, so a server action and an agent/MCP tool are no longer
// "the same thing described twice."
//
//   1. defineAction(): id + description + input schema + run.
//   2. manifest.resource(name, data).actions([...]): the capability manifest a
//      route returns to an agent client.
//   3. invokeAction(id, input): the JSON dispatch path (agent / MCP). RSC's
//      Flight dispatch resolves the same registry.

import { currentTrace } from "./instrumentation";

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
};

export type ActionDefinition<I = unknown, O = unknown> = {
  id: string;
  description: string;
  input: JsonSchema;
  run: (input: I) => O | Promise<O>;
};

// `ActionDefinition` is invariant in its input type (the `run` param), so a
// concretely-typed action is not assignable to `ActionDefinition<unknown>`.
// Collections of heterogeneous actions use this loose alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAction = ActionDefinition<any, any>;

// The single, unified action registry — module-global so any dispatch path
// (agent POST, MCP tools/call, RSC Flight) resolves an action by id.
export const ACTION_REGISTRY = new Map<string, AnyAction>();

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

// JSON dispatch path (agent / MCP): invoke an action by id with a single input.
export async function invokeAction(id: string, input: unknown): Promise<unknown> {
  const action = ACTION_REGISTRY.get(id);
  if (!action) throw new Error(`Unknown action: ${id}`);
  const result = await action.run(input);

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

type ActionManifestEntry = {
  id: string;
  description: string;
  input: JsonSchema;
  // How an agent invokes it. Mirrors the same dispatch the UI uses.
  invoke: { method: "POST"; header: "x-june-action"; action: string };
};

export type ResourceManifestJson = {
  resource: string;
  data: unknown;
  actions: ActionManifestEntry[];
};

export class ResourceManifest<T = unknown> {
  private declared: AnyAction[] = [];

  constructor(
    private readonly name: string,
    private readonly data: T,
  ) {}

  actions(actions: AnyAction[]) {
    this.declared = actions;
    return this;
  }

  toManifest(): ResourceManifestJson {
    return {
      resource: this.name,
      data: this.data,
      actions: this.declared.map((action) => ({
        id: action.id,
        description: action.description,
        input: action.input,
        invoke: { method: "POST", header: "x-june-action", action: action.id },
      })),
    };
  }
}

export function isResourceManifest(value: unknown): value is ResourceManifest {
  return value instanceof ResourceManifest;
}

export const manifest = {
  resource<T>(name: string, data: T) {
    return new ResourceManifest<T>(name, data);
  },
};
