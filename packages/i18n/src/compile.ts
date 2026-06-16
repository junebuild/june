// The ICU layer (phase 3.2). The @formatjs PARSER runs at BUILD time only (parse
// ICU strings → AST); what ships to the runtime is the AST + this small evaluator
// (plural/select via `Intl`, NO string parser) — the design's "compiled at build,
// no runtime ICU parser." The same AST also DERIVES the param types (the edge:
// `t("cart.items", { n: number })` types key AND params).

import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";

/** A compiled message: the parsed ICU AST (what defineMessages ships). */
export type CompiledMessage = MessageFormatElement[];
export type CompiledCatalog = Record<string, CompiledMessage>;

/** BUILD-time: parse one ICU string to its AST. */
export function parseMessage(icu: string): CompiledMessage {
  return parse(icu);
}

/** BUILD-time: parse a whole `{ key: icuString }` catalog to ASTs. */
export function compileCatalog(raw: Record<string, string>): CompiledCatalog {
  const out: CompiledCatalog = {};
  for (const [key, icu] of Object.entries(raw)) out[key] = parseMessage(icu);
  return out;
}

const num = (locale: string, n: number) => new Intl.NumberFormat(locale).format(n);

// RUNTIME: walk the AST. `pound` is the active plural's number (the `#`).
function evaluate(
  els: CompiledMessage,
  locale: string,
  params: Record<string, unknown>,
  pound?: number,
): string {
  let out = "";
  for (const el of els) {
    switch (el.type) {
      case TYPE.literal:
        out += el.value;
        break;
      case TYPE.argument:
        out += el.value in params ? String(params[el.value]) : `{${el.value}}`;
        break;
      case TYPE.number:
        out += num(locale, Number(params[el.value]));
        break;
      case TYPE.pound:
        out += num(locale, pound ?? 0);
        break;
      case TYPE.plural: {
        const n = Number(params[el.value]);
        const exact = `=${n}`;
        const cat =
          el.options[exact] !== undefined
            ? exact
            : new Intl.PluralRules(locale, {
                type: el.pluralType === "ordinal" ? "ordinal" : "cardinal",
              }).select(n - el.offset);
        const opt = el.options[cat] ?? el.options.other;
        if (opt) out += evaluate(opt.value, locale, params, n - el.offset);
        break;
      }
      case TYPE.select: {
        const v = String(params[el.value]);
        const opt = el.options[v] ?? el.options.other;
        if (opt) out += evaluate(opt.value, locale, params, pound);
        break;
      }
      default:
        // date/time/tag: handled by t.rich / later; ignore in the plain string path.
        break;
    }
  }
  return out;
}

/** RUNTIME: format a compiled message in `locale` with `params`. */
export function formatMessage(
  msg: CompiledMessage,
  locale: string,
  params?: Record<string, unknown>,
): string {
  return evaluate(msg, locale, params ?? {});
}

export type ParamType = "string" | "number" | "Date";

/** BUILD-time: the params a message needs, derived from its AST. Plural/number
 *  args are numbers, date/time are Dates, plain `{x}` and select keys are strings.
 *  This is what the codegen turns into `t`'s typed signature. */
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
      default:
        break;
    }
  }
  return into;
}
