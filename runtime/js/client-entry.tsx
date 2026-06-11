// Browser entry: hydrate from the inlined Flight, then handle client-side
// navigation — intercept `<a data-june-link>` clicks, fetch the target route's
// Flight, and swap the tree in place (no full document reload).
// `./webpack-shim-browser` MUST be first.
import "./webpack-shim-browser";

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
    __JUNE_DEV__?: boolean;
  }
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// Turns a server-reference prop into a real call: encode args, POST to the
// action endpoint, decode the Flight response. Passed to every Flight client.
async function callServer(id: string, args: unknown[]) {
  const body = await encodeReply(args);
  return createFromFetch(
    fetch("/__june/action", {
      method: "POST",
      headers: { "x-june-action": id },
      body,
    }),
    { callServer },
  );
}

function fetchFlight(href: string) {
  return createFromFetch(
    fetch(href, { headers: { accept: "text/x-component" } }),
    { callServer },
  );
}

const initial = createFromReadableStream(streamFromText(window.__FLIGHT__), {
  callServer,
});

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
  const target = event.target as HTMLElement;
  const link = target.closest("a[data-june-link]") as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute("href");
  if (!href) return;
  event.preventDefault();
  history.pushState(null, "", href);
  navigate(fetchFlight(href));
});

window.addEventListener("popstate", () => {
  navigate(fetchFlight(location.pathname));
});

// Dev HMR: subscribe to the runtime's change channel. A server-component / action
// edit refetches the current route's Flight and swaps it in place (partial update,
// client component state preserved); a "use client" edit rebuilds the browser
// bundle server-side and triggers a full reload.
if (window.__JUNE_DEV__) {
  const es = new EventSource("/__june/hmr");
  es.addEventListener("change", (event) => {
    if ((event as MessageEvent).data === "full-reload") {
      location.reload();
    } else {
      navigate(fetchFlight(location.pathname));
    }
  });
}
