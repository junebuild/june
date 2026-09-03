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

  test("a hash-only popstate (fragment navigation) does not re-fetch or re-render", async () => {
    let decoded = 0;
    const { calls } = setup({
      decode: async () => {
        decoded++;
        return <p>should not happen</p>;
      },
      response: () => new Response("<flight bytes>", { headers: { "content-type": FLIGHT_ACCEPT } }),
    });
    let scrolled = 0;
    (window as unknown as { scrollTo: () => void }).scrollTo = () => {
      scrolled++;
    };

    // The browser fires popstate for a `#hash` change on the SAME page (a ToC
    // click, a pasted deep link, back/forward between anchors) — it already
    // scrolled to the anchor; the router must not undo that.
    await act(async () => {
      history.replaceState(null, "", `${origin}/#section`);
      window.dispatchEvent(new Event("popstate"));
      await flush();
    });

    expect(calls).toHaveLength(0);
    expect(decoded).toBe(0);
    expect(scrolled).toBe(0);
    expect(document.getElementById("ssr")).not.toBeNull();

    // A traversal to a DIFFERENT page still soft-navigates.
    await act(async () => {
      history.replaceState(null, "", `${origin}/about`);
      window.dispatchEvent(new Event("popstate"));
      await flush();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${origin}/about`);
  });

  test("back to B then forward to the shown page before B arrives: B never renders", async () => {
    let decoded = 0;
    let release!: (r: Response) => void;
    const { calls } = setup({
      decode: async () => {
        decoded++;
        return <p id="b">flight-rendered B</p>;
      },
      // B's flight bytes are slow: the promise resolves only when the test says so.
      response: () => new Promise<Response>((r) => (release = r)) as unknown as Response,
    });

    // Back to B — its fetch is now pending.
    await act(async () => {
      history.replaceState(null, "", `${origin}/about`);
      window.dispatchEvent(new Event("popstate"));
      await flush();
    });
    expect(calls).toHaveLength(1);

    // Forward to the page still on screen: same-page popstate, no new fetch —
    // but B is superseded, so its bytes must not render under this URL.
    await act(async () => {
      history.replaceState(null, "", `${origin}/`);
      window.dispatchEvent(new Event("popstate"));
      await flush();
    });
    expect(calls).toHaveLength(1);

    release(new Response("<flight bytes>", { headers: { "content-type": FLIGHT_ACCEPT } }));
    await act(async () => {
      await flush();
    });
    expect(decoded).toBe(0);
    expect(document.getElementById("b")).toBeNull();
    expect(document.getElementById("ssr")).not.toBeNull();
    expect(location.pathname).toBe("/");
  });

  test("resetting the router also cancels a navigation still in flight", async () => {
    let decoded = 0;
    let release!: (r: Response) => void;
    const { calls } = setup({
      decode: async () => {
        decoded++;
        return <p id="late">late</p>;
      },
      response: () => new Promise<Response>((r) => (release = r)) as unknown as Response,
    });

    await act(async () => {
      clickLink(); // → /about, response pending (history moves only on landing)
      await flush();
    });
    expect(calls).toHaveLength(1);

    // Detach (what the next test's setup does), then let the old response land:
    // the detached router must not render, retitle, or move history.
    __resetFlightRouterForTest();
    document.title = "next test";
    release(
      new Response("<flight bytes>", {
        headers: { "content-type": FLIGHT_ACCEPT, [TITLE_HEADER]: "stale title" },
      }),
    );
    await act(async () => {
      await flush();
    });

    expect(decoded).toBe(0);
    expect(document.getElementById("late")).toBeNull();
    expect(document.getElementById("ssr")).not.toBeNull();
    expect(document.title).toBe("next test");
    expect(location.pathname).toBe("/");
  });

  test("a traversal between /about and /about/ is a navigation, not a hash change", async () => {
    const { calls } = setup({
      decode: async () => <p>page</p>,
      response: () => new Response("<flight bytes>", { headers: { "content-type": FLIGHT_ACCEPT } }),
    });

    await act(async () => {
      clickLink(); // → /about
      await flush();
    });
    expect(calls.map((c) => c.url)).toEqual([`${origin}/about`]);

    // June serves the slash variants verbatim, so this must fetch again.
    await act(async () => {
      history.replaceState(null, "", `${origin}/about/`);
      window.dispatchEvent(new Event("popstate"));
      await flush();
    });
    expect(calls.map((c) => c.url)).toEqual([`${origin}/about`, `${origin}/about/`]);
  });
});
