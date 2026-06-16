// The shell/outlet DOM-marker protocol, shared by BOTH client appliers (the
// soft-nav router and the live-update applier) so they can't drift on which
// element is the shell vs the swap target — drift there silently re-introduces
// the shell-wipe the segment-boundary identity check exists to prevent.
//
// Browser-only (touches `document`); imported by client-router / client-live.
import { OUTLET_ATTR, SHELL_ATTR } from "./nav-protocol";

const ROOT_ATTR = "data-june-root";

export const rootEl = (): Element | null => document.querySelector(`[${ROOT_ATTR}]`);
export const outletEl = (): Element | null => document.querySelector(`[${OUTLET_ATTR}]`);
// The key of the shell currently mounted (stamped on [data-june-root]). Null in
// whole-chain mode / on a non-boundary page.
export const mountedShellKey = (): string | null => rootEl()?.getAttribute(SHELL_ATTR) ?? null;

// Resolve the element a fragment carrying shell key `fragmentShell` morphs into:
//   null key     → whole-chain fragment → the whole [data-june-root]
//   matching key → segment fragment FOR the mounted shell → its [data-june-outlet]
//   other key    → cross-shell, a missing outlet, or a stale shell → null
//                  (the caller hard-navigates rather than corrupting this shell)
export function resolveSwapTarget(fragmentShell: string | null): Element | null {
  if (fragmentShell === null) return rootEl();
  return fragmentShell === mountedShellKey() ? outletEl() : null;
}
