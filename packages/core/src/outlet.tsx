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
import React from "react";

import { OUTLET_ATTR } from "./nav-protocol";

export function JuneOutlet({ children }: { children?: React.ReactNode }) {
  return React.createElement("div", { [OUTLET_ATTR]: "" }, children);
}
