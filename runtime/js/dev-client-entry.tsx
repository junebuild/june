// DEV client: same hydration / navigation / server-actions as client-entry, but
// React + the Flight client are EXTERNAL (served from /@june/deps, one shared
// instance with the un-bundled client components), and a `module-update` HMR
// message re-imports the changed client module and runs a React Fast Refresh
// (component code swapped, state preserved). No full reload for client edits.
//
// The refresh runtime + webpack shim are installed by an inline document script
// that runs BEFORE this module (so React wires into the refresh hook and the
// Flight client sees __webpack_require__), so this file does NOT set them up.

import { createElement, Suspense, use, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import {
  createFromFetch,
  createFromReadableStream,
  encodeReply,
} from "react-server-dom-webpack/client.browser";

declare global {
  interface Window {
    __FLIGHT__: string;
    __JUNE_REFRESH__?: { performReactRefresh: () => void };
    __JUNE_LOADED__?: Record<string, unknown>;
  }
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function callServer(id: string, args: unknown[]) {
  const body = await encodeReply(args);
  return createFromFetch(
    fetch("/__june/action", { method: "POST", headers: { "x-june-action": id }, body }),
    { callServer },
  );
}

function fetchFlight(href: string) {
  return createFromFetch(fetch(href, { headers: { accept: "text/x-component" } }), { callServer });
}

const initial = createFromReadableStream(streamFromText(window.__FLIGHT__), { callServer });

let navigate: (tree: ReturnType<typeof fetchFlight>) => void = () => {};

function Root() {
  const [tree, setTree] = useState(initial);
  navigate = setTree;
  return use(tree) as React.ReactNode;
}

hydrateRoot(
  document.getElementById("root")!,
  createElement(Suspense, { fallback: null }, createElement(Root)),
);

document.addEventListener("click", (event) => {
  const link = (event.target as HTMLElement).closest("a[data-june-link]") as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute("href");
  if (!href) return;
  event.preventDefault();
  history.pushState(null, "", href);
  navigate(fetchFlight(href));
});

window.addEventListener("popstate", () => navigate(fetchFlight(location.pathname)));

// Dev HMR: server edits -> Flight refetch; client edits -> Fast Refresh.
const es = new EventSource("/__june/hmr");
es.addEventListener("change", (event) => {
  const data = (event as MessageEvent).data as string;
  if (data === "rsc-update") {
    navigate(fetchFlight(location.pathname));
  } else if (data.startsWith("module-update:")) {
    hotReloadClientModule(data.slice("module-update:".length));
  } else if (data === "full-reload") {
    location.reload();
  }
});

// Re-import the edited client module (cache-busted). Its footer re-registers the
// same Fast Refresh families, so performReactRefresh() swaps the live components
// while preserving their state. Also refresh the webpack cache for later renders.
async function hotReloadClientModule(rel: string) {
  try {
    const mod = (await import(`/@june/client/${rel}?t=${Date.now()}`)) as Record<string, unknown>;
    const loaded = window.__JUNE_LOADED__ ?? {};
    for (const name of Object.keys(mod)) {
      if (/^[A-Z]/.test(name)) loaded[name] = mod;
    }
    window.__JUNE_REFRESH__?.performReactRefresh();
  } catch (err) {
    console.error("[june] Fast Refresh failed; reloading", err);
    location.reload();
  }
}
