// Rich formatting (t.rich): the AST evaluator that returns ReactNode, so a
// message can embed components — `"Read the <link>docs</link>"` with
// `{ link: (chunks) => <a href="/docs">{chunks}</a> }`. Like format.ts it imports
// only TYPE (no parser); it additionally pulls React (a peer dep) for the tags.

import { createElement, Fragment, type ReactNode } from "react";

import { TYPE } from "@formatjs/icu-messageformat-parser";

import type { CompiledMessage } from "./format";

type RichParams = Record<string, unknown>;

const num = (locale: string, n: number) => new Intl.NumberFormat(locale).format(n);

// Key each node so an array of mixed strings/elements renders without React's
// "missing key" warning.
const keyed = (nodes: ReactNode[]): ReactNode =>
  nodes.length === 1 ? nodes[0] : nodes.map((n, i) => createElement(Fragment, { key: i }, n));

function evaluate(
  els: CompiledMessage,
  locale: string,
  params: RichParams,
  pound?: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  for (const el of els) {
    switch (el.type) {
      case TYPE.literal:
        out.push(el.value);
        break;
      case TYPE.argument:
        out.push(el.value in params ? (params[el.value] as ReactNode) : `{${el.value}}`);
        break;
      case TYPE.number:
        out.push(num(locale, Number(params[el.value])));
        break;
      case TYPE.pound:
        out.push(num(locale, pound ?? 0));
        break;
      case TYPE.tag: {
        const fn = params[el.value] as ((chunks: ReactNode) => ReactNode) | undefined;
        const children = keyed(evaluate(el.children, locale, params, pound));
        out.push(fn ? fn(children) : children);
        break;
      }
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
        if (opt) out.push(...evaluate(opt.value, locale, params, n - el.offset));
        break;
      }
      case TYPE.select: {
        const v = String(params[el.value]);
        const opt = el.options[v] ?? el.options.other;
        if (opt) out.push(...evaluate(opt.value, locale, params, pound));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Format a compiled message to ReactNode, rendering `<tag>` elements via the
 *  matching `(chunks) => ReactNode` param. */
export function formatRich(
  msg: CompiledMessage,
  locale: string,
  params?: RichParams,
): ReactNode {
  return keyed(evaluate(msg, locale, params ?? {}));
}
