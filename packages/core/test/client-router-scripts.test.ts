// Soft-navigation script execution — the regression class this covers: a docs
// page whose interactivity lives in per-page inline scripts (tab switchers, copy
// buttons, diagram renderers) soft-navigated into view via the client router.
// The fragment is parsed with innerHTML, so those scripts arrive inert; without
// the post-morph executeScripts step they never run and the page looks fine but
// is dead (the Kura tabs bug). These tests drive the REAL router end-to-end and
// assert the behaviors work after the swap — hard-navigation parity.
//
// Registers happy-dom WITH JavaScript evaluation (off by default in 20.x) so
// script side effects are real.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const originalFetch = globalThis.fetch;
beforeAll(() =>
  GlobalRegistrator.register({ settings: { enableJavaScriptEvaluation: true } }),
);
afterAll(() => {
  // Same hygiene as the other router suites: the idempotency flag lives on the
  // global window and would survive unregister, muting a later file's
  // startClientRouter; fetch is stubbed per test.
  globalThis.fetch = originalFetch;
  delete (globalThis as { __juneRouter?: boolean }).__juneRouter;
  GlobalRegistrator.unregister();
});

import { startClientRouter } from "@junejs/core/client-router";
import { SEGMENT_HEADER, TITLE_HEADER } from "@junejs/core/nav-protocol";

type W = typeof globalThis & Record<string, unknown>;
const w = globalThis as W;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const fragment = (html: string, headers: Record<string, string> = {}) =>
  (async () => new Response(html, { headers })) as unknown as typeof fetch;

beforeAll(() => {
  (window as unknown as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
    "http://june.test/",
  );
  // The idempotency flag lives on the process-wide globalThis, so an EARLIER
  // test file that booted a router (the june-package e2e suites run the built
  // client bundle) leaves it set — and startClientRouter here would silently
  // no-op, attaching no listeners to THIS file's document. Clear any stale
  // flag first; execution order across files is not guaranteed.
  delete (globalThis as { __juneRouter?: boolean }).__juneRouter;
  // The one router for this file; the rehydrate hook records apply-order so a
  // test can assert scripts run BEFORE island hydration (parse-time parity).
  startClientRouter(() => {
    (w.__applyOrder as string[] | undefined)?.push("rehydrate");
  });
});

function clickLink(href: string) {
  const a = document.querySelector(`a[href="${href}"]`) as HTMLAnchorElement;
  a.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

// A whole-chain page: [data-june-root] with a nav link and the current content.
const page = (links: string, content: string) =>
  `<div data-june-root><nav>${links}</nav>${content}</div>`;

describe("soft-nav executes the fragment's scripts", () => {
  test("Kura-style tabs wired by a per-page inline script WORK after a soft-nav", async () => {
    document.body.innerHTML = page('<a href="/tabs">Tabs</a>', "<main>home</main>");
    // The fragment ships static tab markup + the script that wires it — the
    // exact shape @kurajs/docs emits (per-element listener binding).
    globalThis.fetch = fragment(
      '<nav><a href="/tabs">Tabs</a></nav>' +
        '<div class="tabs">' +
        '<button class="tab-btn" data-tab="0">A</button>' +
        '<button class="tab-btn" data-tab="1">B</button>' +
        '<div class="tab-panel" data-tab="0">PA</div>' +
        '<div class="tab-panel" data-tab="1" hidden>PB</div>' +
        "</div>" +
        "<script>document.querySelectorAll('.tabs').forEach(function(t){t.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){var i=b.getAttribute('data-tab');t.querySelectorAll('.tab-panel').forEach(function(p){p.hidden=p.getAttribute('data-tab')!==i;});});});});</script>",
    );

    clickLink("/tabs");
    await flush();

    const panel = (i: string) =>
      document.querySelector(`.tab-panel[data-tab="${i}"]`) as HTMLElement;
    expect(panel("1").hidden).toBe(true); // initial state from the markup
    const btn = document.querySelector('.tab-btn[data-tab="1"]') as HTMLElement;
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(panel("1").hidden).toBe(false); // the wiring script actually ran
    expect(panel("0").hidden).toBe(true);
  });

  test("scripts run once per navigation — including an IDENTICAL script morph kept", async () => {
    w.__navRuns = 0;
    // Both destinations ship the very same script text: morph keeps an unchanged
    // node, but its bindings targeted replaced DOM — it must still re-run.
    const html = (name: string) =>
      `<nav><a href="/runs-a">A</a><a href="/runs-b">B</a></nav><main>${name}</main>` +
      "<script>window.__navRuns++</script>";

    document.body.innerHTML = page('<a href="/runs-a">A</a><a href="/runs-b">B</a>', "<main>start</main>");
    globalThis.fetch = fragment(html("a"));
    clickLink("/runs-a");
    await flush();
    expect(w.__navRuns).toBe(1);

    globalThis.fetch = fragment(html("b"));
    clickLink("/runs-b");
    await flush();
    expect(w.__navRuns).toBe(2); // once more — not zero (skipped), not doubled
  });

  test("scripts execute BEFORE island re-hydration, like parse-time on a hard load", async () => {
    w.__applyOrder = [] as string[];
    document.body.innerHTML = page('<a href="/order">O</a>', "<main>home</main>");
    globalThis.fetch = fragment(
      '<nav><a href="/order">O</a></nav><script>window.__applyOrder.push("script")</script>',
    );
    clickLink("/order");
    await flush();
    expect(w.__applyOrder).toEqual(["script", "rehydrate"]);
    delete w.__applyOrder;
  });

  test("scripts see the NEW document.title, as on a hard load", async () => {
    document.body.innerHTML = page('<a href="/titled">T</a>', "<main>home</main>");
    document.title = "Old";
    globalThis.fetch = fragment(
      '<nav><a href="/titled">T</a></nav><script>window.__seenTitle = document.title</script>',
      { [TITLE_HEADER]: "New" },
    );
    clickLink("/titled");
    await flush();
    expect(w.__seenTitle).toBe("New"); // title installed before activation
  });

  test("segment mode: outlet scripts run, shell scripts are untouched", async () => {
    w.__segRuns = 0;
    document.body.innerHTML =
      '<div data-june-root data-june-shell="docs">' +
      "<nav><a href=\"/seg\">Seg</a><script>window.__shellRan = true</script></nav>" +
      "<div data-june-outlet><main>home</main></div>" +
      "</div>";
    const shellScript = document.querySelector("nav script")!;
    globalThis.fetch = fragment("<main>seg</main><script>window.__segRuns++</script>", {
      [SEGMENT_HEADER]: "docs",
    });

    clickLink("/seg");
    await flush();

    expect(w.__segRuns).toBe(1); // the swapped outlet's script ran
    expect(document.querySelector("nav script")).toBe(shellScript); // shell: same node,
    expect(w.__shellRan).toBeUndefined(); // never re-run (it's outside the swap region)
  });

  test("a same-origin redirect lands history on the FINAL url (asset base parity)", async () => {
    document.body.innerHTML = page('<a href="/docs">Docs</a>', "<main>home</main>");
    // Requested /docs; the server redirected to /docs/ — only res.url says so.
    globalThis.fetch = (async () => {
      const res = new Response(
        '<nav><a href="/docs">Docs</a></nav><main data-page="docs">d</main><script>window.__redirBase = location.pathname</script>',
      );
      Object.defineProperty(res, "url", { value: "http://june.test/docs/" });
      return res;
    }) as unknown as typeof fetch;

    clickLink("/docs");
    await flush();

    expect(document.querySelector('[data-page="docs"]')).toBeTruthy(); // applied (same origin)
    expect(location.pathname).toBe("/docs/"); // history carries the FINAL url
    expect(w.__redirBase).toBe("/docs/"); // scripts activate under the final base
  });

  test("a fetch that redirected cross-origin is NEVER applied (no foreign scripts)", async () => {
    document.body.innerHTML = page('<a href="/redirected">R</a>', "<main data-keep>home</main>");
    // A same-origin request whose FINAL url (post-redirect) is cross-origin:
    // only `url` distinguishes it — the body is CORS-readable HTML with a script.
    globalThis.fetch = (async () => {
      const res = new Response("<main>evil</main><script>window.__foreignRan = true</script>");
      Object.defineProperty(res, "url", { value: "http://evil.test/landing" });
      return res;
    }) as unknown as typeof fetch;

    clickLink("/redirected");
    await flush();

    expect(document.querySelector("[data-keep]")).toBeTruthy(); // fragment NOT morphed in
    expect(w.__foreignRan).toBeUndefined(); // and its script never ran here
  });

  test("a superseded view-transition callback is inert — no stale morph, no stale scripts", async () => {
    // startViewTransition defers apply; a second navigation can start in the
    // gap. The stale callback must do nothing when it finally runs.
    const captured: Array<() => void> = [];
    (document as { startViewTransition?: (cb: () => void) => void }).startViewTransition = (
      cb,
    ) => {
      captured.push(cb);
    };
    try {
      document.body.innerHTML = page(
        '<a href="/vt-a">A</a><a href="/vt-b">B</a>',
        "<main data-page='start'>home</main>",
      );
      const links = '<nav><a href="/vt-a">A</a><a href="/vt-b">B</a></nav>';
      globalThis.fetch = fragment(`${links}<main data-page="a">a</main><script>window.__vtStale = true</script>`);
      clickLink("/vt-a");
      await flush(); // apply for A captured, NOT yet run
      globalThis.fetch = fragment(`${links}<main data-page="b">b</main><script>window.__vtWinner = true</script>`);
      clickLink("/vt-b");
      await flush(); // apply for B captured — A is now superseded
      expect(captured.length).toBe(2);

      captured[0]!(); // the stale callback fires first, as it would in a browser
      expect(w.__vtStale).toBeUndefined(); // inert: no scripts from the loser
      expect(document.querySelector('[data-page="a"]')).toBeNull(); // and no stale morph

      captured[1]!();
      expect(w.__vtWinner).toBe(true); // the winning navigation applies normally
      expect(document.querySelector('[data-page="b"]')).toBeTruthy();
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
    }
  });

  test("popstate navigation re-executes scripts too", async () => {
    w.__popRuns = 0;
    document.body.innerHTML = page('<a href="/pop">P</a>', "<main>home</main>");
    globalThis.fetch = fragment(
      '<nav><a href="/pop">P</a></nav><main>pop</main><script>window.__popRuns++</script>',
    );
    window.dispatchEvent(new window.Event("popstate"));
    await flush();
    expect(w.__popRuns).toBe(1);
  });
});
