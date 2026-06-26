// The opt-in Flight applier — clientRouter: "flight". The VDOM-over-the-wire
// sibling of the morph router (client-router.ts). A same-origin soft navigation
// fetches the next URL's `flight` projection — the route rendered through the
// server's react-server graph as a React Flight stream — deserializes it with
// React's browser Flight client, and renders it into [data-june-root] through a
// PERSISTENT React root, so React reconciles page→page. Client-component
// ("use client") state is preserved by React's own identity across that
// reconcile — the Route A constraint (never mutate React-owned DOM) is honored
// because here the whole region IS React-owned.
//
// WHY a separate module (not folded into islands-client): it couples to
// react-server-dom — the documented Flight cost. islands-client dynamic-imports
// it ONLY when the document opted in (data-june-router="flight"), so morph users
// never pull react-server-dom into their bundle.
//
// DEGRADES SAFELY: no JS, a failed fetch, a server with no flight projection yet
// (the common case until runtime-convergence.md #1/#2 land — the response simply
// isn't a flight payload), or a decode error all fall back to a hard browser
// navigation. So `clientRouter: "flight"` is safe to set today: it hard-navigates
// until the server can answer, then upgrades to soft Flight nav with no client
// change.
//
// NOTE on islands: the Flight model expects islands to arrive AS client
// references inside the stream (React renders them in this root). It deliberately
// does NOT run the `<june-island>` marker rehydrate step — that marker+separate-
// root model is morph's, and is incompatible with a single React root owning the
// region. Bridging June's marker islands to client references is part of the
// blocked server work; the applier is written for the client-reference shape it
// will receive.
//
// PURE per the contract layer's rule (no node:*/Bun.*); browser-only (touches
// document/history/fetch/react-dom/client), exposed only via the
// @junejs/core/client-router-flight subpath, never re-exported from the barrel.
import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { FLIGHT_ACCEPT, TITLE_HEADER, decodeTitle } from "./nav-protocol";

// Deserialize a Flight byte stream into a React node. Injectable so the
// navigation orchestration is testable without react-server-dom; the default
// lazily pulls React's browser Flight client (kept out of the morph bundle, and
// absent until that dep is installed — in which case decode rejects and the nav
// hard-falls-back, which is the intended graceful behavior).
export type FlightDecoder = (stream: ReadableStream<Uint8Array>) => Promise<React.ReactNode>;

async function defaultDecode(stream: ReadableStream<Uint8Array>): Promise<React.ReactNode> {
  // Indirect specifier on purpose: react-server-dom-webpack is NOT a dependency
  // of the contract layer (morph users must never pull it). It resolves only in a
  // flight-opted client build; absent, this import rejects and the nav hard-falls-
  // back. The indirection also keeps it out of TS's static module resolution.
  const specifier = "react-server-dom-webpack/client.browser";
  const mod = (await import(specifier)) as {
    createFromReadableStream: (s: ReadableStream<Uint8Array>) => React.ReactNode;
  };
  return mod.createFromReadableStream(stream);
}

export type FlightRouterOptions = { decode?: FlightDecoder };

const trimSlash = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

// Agent surfaces + non-HTML stay hard navigations — same exclusions as morph.
function isHardNav(url: URL): boolean {
  return /\.(md|json|txt|xml)$/.test(url.pathname) || url.pathname === "/mcp";
}

let started = false;

export function startFlightRouter(options: FlightRouterOptions = {}): void {
  // Idempotent: islands-client may call this on every full-document hydrate.
  if (started) return;
  const rootEl = document.querySelector("[data-june-root]");
  if (!rootEl) return;
  started = true;
  const decode = options.decode ?? defaultDecode;

  // Persistent root: created on the first soft nav (it replaces the SSR markup
  // once), reused after so React reconciles each subsequent page against the
  // previous one — that reconcile is what preserves client state.
  let root: Root | null = null;

  function hard(href: string): void {
    location.href = href;
  }

  async function navigate(href: string, push: boolean): Promise<void> {
    const url = new URL(href, location.href);
    try {
      const res = await fetch(url.href, { headers: { accept: FLIGHT_ACCEPT } });
      // No flight projection (server can't answer yet) → hard navigate. We treat
      // a non-flight content-type as "not available" so a server that ignores the
      // Accept and returns HTML doesn't get mis-parsed as Flight.
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok || !res.body || !ct.includes(FLIGHT_ACCEPT)) return hard(url.href);

      const node = await decode(res.body);
      root ??= createRoot(rootEl as Element);
      root.render(React.createElement(React.Fragment, null, node));

      // Server encodeTitles the header; decode before assigning to document.title.
      const title = decodeTitle(res.headers.get(TITLE_HEADER));
      if (title) document.title = title;
      if (push) history.pushState(null, "", url.href);
      window.scrollTo(0, 0);
    } catch {
      hard(url.href);
    }
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || isHardNav(url)) return;
    // Same page (ignoring a trailing slash) → let the browser handle the hash.
    if (trimSlash(url.pathname) === trimSlash(location.pathname) && url.search === location.search) {
      return;
    }
    e.preventDefault();
    void navigate(url.href, true);
  });

  window.addEventListener("popstate", () => void navigate(location.href, false));
}

// Test seam: reset the module-level guard so a test can start a fresh router.
export function __resetFlightRouterForTest(): void {
  started = false;
}
