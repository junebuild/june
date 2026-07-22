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
