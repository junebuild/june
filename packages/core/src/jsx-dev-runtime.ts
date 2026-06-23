// Dev half of June's JSX runtime (jsxImportSource resolves here in development).
// Same island-marker behavior as jsx-runtime; delegates non-islands to React's
// dev jsx so the dev-only warnings/source info are preserved.
import { jsxDEV as rjsxDEV, Fragment } from "react/jsx-dev-runtime";

import { islandMarker } from "./jsx-runtime";

export { Fragment };
export type { JSX } from "./jsx-runtime";

export function jsxDEV(
  type: unknown,
  props: Record<string, unknown> | null,
  key?: unknown,
  isStaticChildren?: boolean,
  source?: unknown,
  self?: unknown,
): unknown {
  return (
    islandMarker(type, props) ??
    rjsxDEV(type as never, props as never, key as never, isStaticChildren as never, source as never, self as never)
  );
}
