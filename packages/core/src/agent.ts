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
  // readonly so an `as const` schema (which an extracted schema variable needs to
  // keep its literals for InferInput) still satisfies the constraint. Inline
  // schema literals infer via the `const` type param without `as const`.
  required?: readonly string[];
};

// Map June's flat JSON-Schema subset → a TS type. June's schema is intentionally
// minimal (type:"object" + flat properties + required[]), so this is a small
// in-house mapped type — no json-schema-to-ts, no recursive constraint, no
// TS2589, no new dependency. `defineAction` captures the schema as a `const`
// literal so the property `type` strings survive as literals for this to read.
type JsonPrimitive<T> = T extends "string"
  ? string
  : T extends "number" | "integer"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "array"
        ? unknown[]
        : T extends "object"
          ? Record<string, unknown>
          : unknown;

type RequiredName<S extends JsonSchema> = S["required"] extends readonly string[]
  ? S["required"][number]
  : never;

export type InferInput<S extends JsonSchema> = {
  [K in keyof S["properties"] as K extends RequiredName<S> ? K : never]: JsonPrimitive<
    S["properties"][K]["type"]
  >;
} & {
  [K in keyof S["properties"] as K extends RequiredName<S> ? never : K]?: JsonPrimitive<
    S["properties"][K]["type"]
  >;
};

// In-house runtime validation matching the schema's expressiveness: required keys
// present + each declared property's primitive type. Extra keys are allowed
// (June's schema has no additionalProperties). Returns an error string, or null
// when valid. Lives in core (pure, no deps) — the dispatch boundary that needs it
// is here, and June's flat schema needs no ajv.
export function validateInput(schema: JsonSchema, input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "input must be an object";
  }
  const obj = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined) return `missing required property "${key}"`;
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = obj[key];
    if (v === undefined) continue; // absent optional (absent required caught above)
    const t = prop.type;
    const ok =
      t === "string"
        ? typeof v === "string"
        : t === "number"
          ? typeof v === "number"
          : t === "integer"
            ? typeof v === "number" && Number.isInteger(v)
            : t === "boolean"
              ? typeof v === "boolean"
              : t === "array"
                ? Array.isArray(v)
                : t === "object"
                  ? typeof v === "object" && v !== null && !Array.isArray(v)
                  : true; // unknown declared type → don't reject
    if (!ok) return `property "${key}" must be ${t}`;
  }
  return null;
}

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

// `input` is the SINGLE source: run()'s param type is INFERRED from the schema
// (no second hand-written type), and invokeAction validates against the SAME
// schema. `const S` captures the schema literal so InferInput can read it.
export function defineAction<const S extends JsonSchema, O>(def: {
  id: string;
  description: string;
  input: S;
  run: (input: InferInput<S>, ctx: ActionContext) => O | Promise<O>;
}): ActionDefinition<InferInput<S>, O> {
  const action = def as unknown as ActionDefinition<InferInput<S>, O>;
  const existing = ACTION_REGISTRY.get(def.id);
  if (existing && existing !== (action as unknown as AnyAction)) {
    // Don't silently overwrite — a clashing id is almost always a bug.
    console.warn(`[june] defineAction: id "${def.id}" is already registered — overwriting.`);
  }
  ACTION_REGISTRY.set(def.id, action as unknown as AnyAction);
  serverReferenceRegistrar?.(def.run as (...args: unknown[]) => unknown, def.id);
  return action;
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
  // Enforce the schema at the dispatch boundary — /mcp is untrusted input. This
  // used to be a no-op (the schema only described, never enforced).
  const invalid = validateInput(action.input, input);
  if (invalid) throw new Error(`Invalid input for "${id}": ${invalid}`);
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
