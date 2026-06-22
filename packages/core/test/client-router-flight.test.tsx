// The Flight applier's navigation orchestration. The Flight DECODE is injected
// (a fake), so this exercises the real click→fetch→render→history pipeline
// without react-server-dom — and proves the graceful hard-nav fallback when the
// server has no flight projection yet.
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const origin = "http://localhost:3000";

beforeAll(() => GlobalRegistrator.register({ url: `${origin}/` }));
afterAll(() => GlobalRegistrator.unregister());

import { act } from "react";
import { FLIGHT_ACCEPT, TITLE_HEADER } from "@junejs/core/nav-protocol";
import {
  startFlightRouter,
  __resetFlightRouterForTest,
  type FlightDecoder,
} from "@junejs/core/client-router-flight";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FetchCall = { url: string; accept: string };

function setup(opts: {
  decode: FlightDecoder;
  response: () => Response;
}): { calls: FetchCall[] } {
  __resetFlightRouterForTest();
  history.replaceState(null, "", `${origin}/`);
  (window as unknown as { scrollTo: () => void }).scrollTo = () => {};

  // A clientRouter page: [data-june-root] + a same-origin link.
  document.body.innerHTML = `
    <div data-june-root data-june-router="flight">
      <main><p id="ssr">server-rendered home</p></main>
      <a id="link" href="${origin}/about">About</a>
    </div>`;

  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const accept = (init?.headers as Record<string, string> | undefined)?.accept ?? "";
    calls.push({ url, accept });
    return opts.response();
  }) as typeof fetch;

  startFlightRouter({ decode: opts.decode });
  return { calls };
}

function clickLink(): void {
  document
    .getElementById("link")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startFlightRouter", () => {
  beforeEach(() => __resetFlightRouterForTest());

  test("click → fetch flight projection → render into root → title + history", async () => {
    let decoded = 0;
    const { calls } = setup({
      decode: async () => {
        decoded++;
        return <p id="flight">flight-rendered about</p>;
      },
      response: () =>
        new Response("<flight bytes>", {
          headers: { "content-type": FLIGHT_ACCEPT, [TITLE_HEADER]: "About — Acme" },
        }),
    });

    await act(async () => {
      clickLink();
      await flush();
    });

    // Asked for the flight projection of the clicked URL.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${origin}/about`);
    expect(calls[0]!.accept).toBe(FLIGHT_ACCEPT);
    // Decoded once and the streamed tree replaced the SSR markup in the root.
    expect(decoded).toBe(1);
    expect(document.getElementById("flight")?.textContent).toBe("flight-rendered about");
    expect(document.getElementById("ssr")).toBeNull();
    // Title + URL updated (soft nav, not a reload).
    expect(document.title).toBe("About — Acme");
    expect(location.pathname).toBe("/about");
  });

  test("no flight projection (HTML response) → does NOT decode (hard-nav fallback)", async () => {
    let decoded = 0;
    setup({
      decode: async () => {
        decoded++;
        return <p>should not happen</p>;
      },
      // Server ignores the Accept and returns a normal HTML document.
      response: () => new Response("<html>...</html>", { headers: { "content-type": "text/html" } }),
    });

    await act(async () => {
      clickLink();
      await flush();
    });

    // The applier refused to parse non-flight content as Flight: no decode, the
    // SSR markup is untouched (the browser hard-navigates instead).
    expect(decoded).toBe(0);
    expect(document.getElementById("ssr")).not.toBeNull();
  });
});
