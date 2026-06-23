// June's JSX runtime — the transform-free island primitive.
//
// Set `jsxImportSource: "@junejs/core"` and the standard JSX compile routes every
// element through this `jsx()` (NOT an AST transform — it's the function the
// compiler already calls). When a COMPONENT is used with a `client:*` directive
// (`<Counter client:visible/>`), we emit the `<june-island>` hydration marker
// around its SSR — so a PLAIN "use client" component becomes an island with no
// `island()` wrapper. Everything else (host elements, components without a
// directive) passes straight through to React.
//
// The marker is byte-identical to the island() one (same attrs), so the client
// runtime, morph, and persist all keep working unchanged.
import { jsx as rjsx, jsxs as rjsxs, Fragment } from "react/jsx-runtime";

import {
  ISLAND_TAG,
  ISLAND_NAME_ATTR,
  ISLAND_PROPS_ATTR,
  ISLAND_STRATEGY_ATTR,
  ISLAND_PERSIST_ATTR,
  ISLAND_SLOT_ATTR,
  JuneSlot,
  serializeIslandProps,
  type Strategy,
} from "./islands";

export { Fragment };
// The JSX namespace (the type side jsxImportSource resolves) IS React's — re-exported.
export type { JSX } from "react/jsx-runtime";

// …augmented with the `client:*` hydration directives, so `<Counter client:visible/>`
// type-checks on any component and a typo (`client:bogus`) is a compile error. This
// merges into React's JSX.IntrinsicAttributes (loaded with this module).
declare module "react" {
  namespace JSX {
    interface IntrinsicAttributes {
      "client:load"?: boolean;
      "client:idle"?: boolean;
      "client:visible"?: boolean;
      "client:only"?: boolean;
      // Carry the island's live node across a soft navigation (only on an island,
      // i.e. alongside a client:* directive).
      persist?: boolean;
    }
  }
}

const DIRECTIVE = "client:";

// If `type` is a component used with a truthy `client:<strategy>` directive, build
// its island marker; otherwise return null (the caller passes through to React).
export function islandMarker(type: unknown, props: Record<string, unknown> | null): unknown {
  if (typeof type !== "function" || props == null) return null;
  // Fast path: a component is an island ONLY if some prop is a `client:*` directive.
  // The common case is a normal component render — bail here, before allocating
  // `rest`, so the whole tree doesn't pay an O(props) copy + alloc per element.
  let isIsland = false;
  for (const k in props) {
    if (k.charCodeAt(0) === 99 /* 'c' */ && k.startsWith(DIRECTIVE)) {
      isIsland = true;
      break;
    }
  }
  if (!isIsland) return null;

  let strategy: Strategy | undefined;
  let persist = false;
  const rest: Record<string, unknown> = {};
  for (const k in props) {
    if (k.startsWith(DIRECTIVE)) {
      if (props[k]) strategy = k.slice(DIRECTIVE.length) as Strategy;
    } else if (k === "persist") {
      persist = Boolean(props[k]);
    } else {
      rest[k] = props[k];
    }
  }
  if (!strategy) return null; // only `client:false` directives → not an island

  const name = (type as { displayName?: string; name?: string }).displayName || (type as { name?: string }).name;
  // Slot island: a component used WITH children is an interactive shell wrapping
  // server-rendered content. Wrap the children in <JuneSlot> (server: renders them
  // as zero-JS HTML inside <june-slot>; client: re-renders the captured HTML
  // opaquely so it hydrates 1:1 and never reconciles). The component just renders
  // `{children}`. A leaf island taking no children is the common case (no slot).
  const { children, ...serializable } = rest;
  // A slot island is one given real children. Whitespace-only string children (a
  // stray space/newline) don't count — a leaf island isn't a slot by accident.
  const hasSlot =
    children != null && children !== false && !(typeof children === "string" && children.trim() === "");
  if (hasSlot && strategy === "only") {
    throw new Error(
      `[june] island <${name} client:only/> cannot take children — client:only is never server-rendered, so there is no server content to slot.`,
    );
  }
  const componentProps = hasSlot ? { ...serializable, children: rjsx(JuneSlot as never, { children } as never) } : serializable;
  return rjsx(ISLAND_TAG as never, {
    [ISLAND_NAME_ATTR]: name,
    [ISLAND_STRATEGY_ATTR]: strategy,
    [ISLAND_PROPS_ATTR]: serializeIslandProps(serializable), // children never serialize; they SSR via the slot
    ...(persist ? { [ISLAND_PERSIST_ATTR]: "" } : {}),
    ...(hasSlot ? { [ISLAND_SLOT_ATTR]: "" } : {}),
    // "only" → never server-render (client mounts fresh); else SSR the component.
    children: strategy === "only" ? undefined : rjsx(type as never, componentProps as never),
  } as never);
}

export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): unknown {
  return islandMarker(type, props) ?? rjsx(type as never, props as never, key as never);
}

export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): unknown {
  return islandMarker(type, props) ?? rjsxs(type as never, props as never, key as never);
}
