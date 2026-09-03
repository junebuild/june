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
      // Landed elements are logged by id, or `tag[name=…]` for a named anchor.
      scrolledInto.push(this.id || `${this.localName}[name=${this.getAttribute("name")}]`);
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

  test("the raw fragment is tried before its decoded form (spec order)", async () => {
    // An id that literally contains percent escapes wins over the decoded id
    // when both exist — the browser's fragment lookup tries raw first.
    document.body.innerHTML = root('<main><a href="/raw#%E8%A8%82">raw</a></main>');
    serve('<main data-page="raw"><h2 id="訂">decoded</h2><h2 id="%E8%A8%82">raw</h2></main>');

    clickLink("/raw#%E8%A8%82");
    await flush();

    expect(scrolledInto).toEqual(["%E8%A8%82"]);
  });

  test("a malformed escape does not discard the well-formed ones (forgiving decode)", async () => {
    // decodeURIComponent("a%20b%ZZ") throws; the browser resolves it to "a b%ZZ".
    document.body.innerHTML = root('<main><a href="/mixed#a%20b%ZZ">mixed</a></main>');
    serve('<main data-page="mixed"><h2 id="a b%ZZ">target</h2></main>');

    clickLink("/mixed#a%20b%ZZ");
    await flush();

    expect(scrolledInto).toEqual(["a b%ZZ"]);
    expect(scrolledTo).toEqual([]);
  });

  test("the name fallback matches only <a>, not a same-named form control", async () => {
    document.body.innerHTML = root('<main><a href="/legacy#sec">legacy</a></main>');
    serve('<main data-page="legacy"><input name="sec"><a name="sec">anchor</a></main>');

    clickLink("/legacy#sec");
    await flush();

    expect(scrolledInto).toEqual(["a[name=sec]"]);
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

  test("a same-page popstate in the view-transition gap does not strand the old DOM", async () => {
    // Prime a known page (the router keys "same page?" on its last landing).
    document.body.innerHTML = root('<main data-page="vt-home">h</main>');
    serve('<main data-page="vt-home"><a href="/vt-next">next</a></main>');
    popstate("/vt-home");
    await flush();

    // startViewTransition defers apply: history already says /vt-next while the
    // old DOM is still on screen.
    const captured: Array<() => void> = [];
    (document as { startViewTransition?: (cb: () => void) => void }).startViewTransition = (
      cb,
    ) => {
      captured.push(cb);
    };
    try {
      serve('<main data-page="vt-next"><h2 id="sec">s</h2></main>');
      clickLink("/vt-next");
      await flush();
      expect(location.pathname).toBe("/vt-next");
      expect(captured.length).toBe(1); // apply captured, not yet run
      expect(document.querySelector('[data-page="vt-home"]')).not.toBeNull();

      // A fragment navigation in that gap resolves against the NEW url. The
      // router must not treat /vt-next as already shown and dismiss its own
      // pending apply — that would leave the old page under the new URL.
      popstate("/vt-next#sec");
      await flush();
      for (const cb of captured) cb();
      await flush();

      expect(document.querySelector('[data-page="vt-next"]')).not.toBeNull();
      expect(document.querySelector('[data-page="vt-home"]')).toBeNull();
      expect(location.pathname).toBe("/vt-next");
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
    }
  });

  test("back to B then forward to the shown page before B arrives: B never lands", async () => {
    // Land somewhere known first (the router keys "same page?" on its last landing).
    document.body.innerHTML = root('<main data-page="faq">f</main>');
    serve('<main data-page="home">h</main>');
    popstate("/home");
    await flush();
    expect(document.querySelector('[data-page="home"]')).not.toBeNull();
    fetched = [];

    // Back to B: its fragment is slow. Capture the signal the router hands fetch.
    let release!: (r: Response) => void;
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      fetched.push(typeof input === "string" ? input : input.toString());
      signal = init?.signal ?? undefined;
      return new Promise<Response>((r) => {
        release = r;
      });
    }) as unknown as typeof fetch;
    popstate("/b");
    await flush();
    expect(fetched).toEqual(["/b"]);
    expect(signal?.aborted).toBe(false);

    // Forward to the page still on screen: a fragment-class popstate, but the
    // pending B fetch must be superseded — otherwise B would morph in under
    // /home's URL once it resolved.
    popstate("/home");
    await flush();
    expect(signal?.aborted).toBe(true);

    release(new Response('<main data-page="b">b</main>'));
    await flush();
    expect(document.querySelector('[data-page="home"]')).not.toBeNull();
    expect(document.querySelector('[data-page="b"]')).toBeNull();
    expect(fetched).toEqual(["/b"]); // and the shown page was not re-fetched either
    expect(location.pathname).toBe("/home");
  });
});
