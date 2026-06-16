// <JuneOutlet> — the segment-scoped swap boundary.
//
// A nested-layout site (e.g. docs with a big sidebar in a shared OUTER layout)
// can opt a layout into being the PERSISTENT SHELL: render the shell around a
// <JuneOutlet> that wraps `children`, and the client router will morph only the
// outlet's contents on soft navigation — the shell is never re-rendered, re-sent,
// or walked.
//
//   // app/(docs)/layout.tsx
//   export const segmentBoundary = true;        // ← static signal: server slices here
//   export default function DocsLayout({ children }) {
//     return <Shell><Sidebar/><JuneOutlet>{children}</JuneOutlet></Shell>;
//   }
//
// The `segmentBoundary` EXPORT is load-bearing: it lets the server decide which
// layouts to skip WITHOUT rendering them (rendering the shell to "find" the outlet
// would defeat the optimization). <JuneOutlet> is only the DOM marker the client
// morphs into. A layout that exports the flag MUST render <JuneOutlet>, or the
// client finds no live outlet and falls back to a hard navigation.
//
// With no boundary declared, <JuneOutlet> is a harmless plain wrapper and the
// whole [data-june-root] stays the swap region (the default).
//
// CONSTRAINT: a soft-nav fragment renders ONLY the content below the boundary, so
// the boundary layout (and anything above it) is NOT re-rendered. Keep the shell
// to route-independent chrome — DOM, sidebars, nav. Any React Context Provider
// (or state) that the *page* depends on must live AT OR BELOW the boundary
// (inside <JuneOutlet>), not in the shell above it: a provider in the shell is
// present on a hard load but absent in the fragment, so the page would read the
// context default after a soft navigation.
import React from "react";

import { OUTLET_ATTR } from "./nav-protocol";

export function JuneOutlet({ children }: { children?: React.ReactNode }) {
  return React.createElement("div", { [OUTLET_ATTR]: "" }, children);
}
