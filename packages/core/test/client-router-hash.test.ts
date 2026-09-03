// Fragment navigations vs. the client router. The browser fires popstate for a
// `#hash` change too — a ToC click, a pasted same-page deep link, back/forward
// between two anchors — and the router must leave those alone: the browser has
// already scrolled to the anchor, and a soft-nav on top of it would re-fetch the
// page and drag the reader back to the top. A cross-page link that carries a
// hash is the other half: it lands on the section, like a hard load would.
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterAll(() => {
  // Don't leak global state to other test files: the router's idempotency flag
  // lives on the (global) window, and `window === globalThis` here.
  globalThis.fetch = originalFetch;
  delete (globalThis as { __juneRouter?: boolean }).__juneRouter;
  GlobalRegistrator.unregister();
});

import { startClientRouter } from "@junejs/core/client-router";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// Every fetch the router makes (by href), every window.scrollTo, and every
// element.scrollIntoView (by id) — reset per test.
let fetched: string[] = [];
let scrolledTo: [number, number][] = [];
let scrolledInto: string[] = [];

// A whole-chain fragment (no segment header) morphs into [data-june-root].
function serve(html: string) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(typeof input === "string" ? input : input.toString());
    return new Response(html);
  }) as unknown as typeof fetch;
}

const root = (inner: string) => `<div data-june-root>${inner}</div>`;

function clickLink(href: string) {
  const a = document.querySelector(`a[href="${href}"]`) as HTMLAnchorElement;
  a.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

function popstate(url: string) {
  // A real popstate fires AFTER the browser updated location.
  history.replaceState({}, "", url);
  window.dispatchEvent(new window.Event("popstate"));
}

beforeAll(() => {
  // The router snapshots the current page when it starts, so the URL comes first.
  (window as unknown as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
    "http://june.test/docs",
  );
  (window as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo = (x, y) => {
    scrolledTo.push([x, y]);
  };
  (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
    function (this: HTMLElement) {
      scrolledInto.push(this.id);
    };
  delete (globalThis as { __juneRouter?: boolean }).__juneRouter;
  startClientRouter(() => {});
});

beforeEach(() => {
  fetched = [];
  scrolledTo = [];
  scrolledInto = [];
});

describe("fragment navigation and the client router", () => {
  test("a hash-only popstate (ToC click / same-page deep link) is left to the browser", async () => {
    document.body.innerHTML = root('<main data-page="docs"><h2 id="usage">Usage</h2></main>');
    serve('<main data-page="refetched">x</main>');

    popstate("/docs#usage");
    await flush();

    expect(fetched).toEqual([]); // no soft-nav…
    expect(scrolledTo).toEqual([]); // …and nothing yanked the reader back to the top
    expect(document.querySelector('[data-page="docs"]')).not.toBeNull(); // page untouched
    expect(location.hash).toBe("#usage");
  });

  test("back/forward between two anchors of the same page is a no-op too", async () => {
    document.body.innerHTML = root('<main data-page="docs"><h2 id="a">A</h2><h2 id="b">B</h2></main>');
    serve('<main data-page="refetched">x</main>');

    popstate("/docs#a");
    popstate("/docs#b");
    popstate("/docs"); // back past the first anchor: same page, hash cleared
    await flush();

    expect(fetched).toEqual([]);
    expect(scrolledTo).toEqual([]);
    expect(document.querySelector('[data-page="docs"]')).not.toBeNull();
  });

  test("a popstate that changes the path still soft-navigates", async () => {
    document.body.innerHTML = root('<main data-page="docs">d</main>');
    serve('<main data-page="other">o</main>');

    popstate("/other");
    await flush();

    expect(fetched).toEqual(["/other"]);
    expect(document.querySelector('[data-page="other"]')).not.toBeNull();
    expect(scrolledTo).toEqual([[0, 0]]); // a page without a hash lands at the top
  });

  test("after a soft-nav, a hash-only popstate on the NEW page is still ignored", async () => {
    // The previous test soft-navigated to /other; the router must key its
    // "same page?" check on where the LAST navigation landed, not where it booted.
    document.body.innerHTML = root('<main data-page="other"><h2 id="sec">S</h2></main>');
    serve('<main data-page="refetched">x</main>');

    popstate("/other#sec");
    await flush();

    expect(fetched).toEqual([]);
    expect(document.querySelector('[data-page="other"]')).not.toBeNull();
  });

  test("a cross-page link with a hash lands on the section, not the top", async () => {
    document.body.innerHTML = root('<main><a href="/guide#install">Install</a></main>');
    serve('<main data-page="guide"><h2 id="intro">Intro</h2><h2 id="install">Install</h2></main>');

    clickLink("/guide#install");
    await flush();

    expect(fetched).toEqual(["/guide#install"]);
    expect(location.pathname).toBe("/guide");
    expect(location.hash).toBe("#install");
    expect(scrolledInto).toEqual(["install"]);
    expect(scrolledTo).toEqual([]);
  });

  test("a percent-encoded hash (non-ASCII heading ids) resolves to its element", async () => {
    document.body.innerHTML = root('<main><a href="/api#%E8%A8%82%E9%96%B1">訂閱</a></main>');
    serve('<main data-page="api"><h2 id="訂閱">訂閱</h2></main>');

    clickLink("/api#%E8%A8%82%E9%96%B1");
    await flush();

    expect(scrolledInto).toEqual(["訂閱"]);
    expect(scrolledTo).toEqual([]);
  });

  test("a hash that names nothing on the new page falls back to the top", async () => {
    document.body.innerHTML = root('<main><a href="/faq#nope">FAQ</a></main>');
    serve('<main data-page="faq">f</main>');

    clickLink("/faq#nope");
    await flush();

    expect(document.querySelector('[data-page="faq"]')).not.toBeNull();
    expect(scrolledInto).toEqual([]);
    expect(scrolledTo).toEqual([[0, 0]]);
  });
});
