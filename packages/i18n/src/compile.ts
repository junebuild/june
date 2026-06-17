// BUILD-time ICU compilation. The @formatjs PARSER lives HERE only (ICU string →
// AST) — never imported by the runtime (index.ts → format.ts). What ships is the
// AST + the format.ts evaluator. The same AST also DERIVES the param types (the
// edge: `t("cart.items", { n: number })` types key AND params).

import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

import type { CompiledCatalog, CompiledMessage } from "./format";

export type { CompiledCatalog, CompiledMessage } from "./format";

/** Parse one ICU string to its AST. */
export function parseMessage(icu: string): CompiledMessage {
  return parse(icu);
}

/** Parse a whole `{ key: icuString }` catalog to ASTs. */
export function compileCatalog(raw: Record<string, string>): CompiledCatalog {
  const out: CompiledCatalog = {};
  for (const [key, icu] of Object.entries(raw)) out[key] = parseMessage(icu);
  return out;
}

// "tag" = a `<x>…</x>` rich element → a (chunks: ReactNode) => ReactNode param,
// rendered by t.rich (not the plain string t).
export type ParamType = "string" | "number" | "Date" | "tag";

/** The params a message needs, derived from its AST. Plural/number args are
 *  numbers, date/time are Dates, plain `{x}` and select keys are strings. This is
 *  what the codegen turns into `t`'s typed signature. */
export function deriveParams(
  msg: CompiledMessage,
  into: Record<string, ParamType> = {},
): Record<string, ParamType> {
  for (const el of msg) {
    switch (el.type) {
      case TYPE.argument:
        into[el.value] ??= "string";
        break;
      case TYPE.number:
        into[el.value] = "number";
        break;
      case TYPE.date:
      case TYPE.time:
        into[el.value] = "Date";
        break;
      case TYPE.plural:
        into[el.value] = "number";
        for (const o of Object.values(el.options)) deriveParams(o.value, into);
        break;
      case TYPE.select:
        into[el.value] ??= "string";
        for (const o of Object.values(el.options)) deriveParams(o.value, into);
        break;
      case TYPE.tag:
        into[el.value] = "tag";
        deriveParams(el.children, into);
        break;
      default:
        break;
    }
  }
  return into;
}
