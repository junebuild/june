// RUNTIME message formatting — the AST evaluator. It imports only the `TYPE` enum
// from @formatjs (the parser `parse` is NOT reachable from here), so the runtime
// bundle ships the evaluator + Intl, never the ICU string parser. The build path
// (compile.ts) owns parsing; this owns evaluating what the build produced.

import { TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";

/** A compiled message: the parsed ICU AST (what defineMessages ships). */
export type CompiledMessage = MessageFormatElement[];
export type CompiledCatalog = Record<string, CompiledMessage>;

const num = (locale: string, n: number) => new Intl.NumberFormat(locale).format(n);

// Walk the AST. `pound` is the active plural's number (the `#`).
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
        // date/time/tag: handled by t.rich / later; ignored in the plain path.
        break;
    }
  }
  return out;
}

/** Format a compiled message in `locale` with `params`. */
export function formatMessage(
  msg: CompiledMessage,
  locale: string,
  params?: Record<string, unknown>,
): string {
  return evaluate(msg, locale, params ?? {});
}
