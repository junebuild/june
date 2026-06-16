// Segment-scoped client navigation: a soft-nav whose fragment is marked
// segment-scoped (x-june-segment) morphs into the live [data-june-outlet] ONLY —
// the shell (sidebar) outside the outlet is never touched — and the shell's
// active-nav highlight is reconciled from location.pathname. If the server marks
// a fragment segment-scoped but no live outlet exists, the router hard-navigates
// rather than corrupting the page.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterAll(() => {
  // Don't leak global state to other test files: the router's idempotency flag
  // lives on the (global) window, and `window === globalThis` here, so it would
  // survive unregister and make a later file's startClientRouter a no-op.
  globalThis.fetch = originalFetch;
  delete (globalThis as { __juneRouter?: boolean }).__juneRouter;
  GlobalRegistrator.unregister();
});

import { startClientRouter } from "@junejs/core/client-router";
import { SEGMENT_HEADER, TITLE_HEADER } from "@junejs/core/nav-protocol";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// A real base URL so the click handler's `new URL(a.href, location.href)` and the
// active-link origin check resolve; then one router per process (it's idempotent).
beforeAll(() => {
  (window as unknown as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
    "http://june.test/",
  );
  startClientRouter(() => {});
});

function clickLink(href: string) {
  const a = document.querySelector(`a[href="${href}"]`) as HTMLAnchorElement;
  a.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

describe("segment-scoped client navigation", () => {
  test("morphs the outlet only, leaves the shell, and moves aria-current", async () => {
    document.body.innerHTML =
      '<div data-june-root>' +
      '<nav data-sidebar>' +
      '<a href="/" aria-current="page">Home</a>' +
      '<a href="/guide">Guide</a>' +
      "</nav>" +
      '<div data-june-outlet><main><h1 data-page="home">Home</h1></main></div>' +
      "</div>";
    const sidebar = document.querySelector("[data-sidebar]")!;

    globalThis.fetch = (async () =>
      new Response('<main><h1 data-page="guide">Guide</h1></main>', {
        headers: { [SEGMENT_HEADER]: "1", [TITLE_HEADER]: "Guide" },
      })) as unknown as typeof fetch;

    clickLink("/guide");
    await flush();

    // outlet content swapped...
    expect(document.querySelector("[data-june-outlet]")!.innerHTML).toContain('data-page="guide"');
    // ...sidebar (outside the outlet) is the SAME node, untouched
    expect(document.querySelector("[data-sidebar]")).toBe(sidebar);
    // active highlight moved Home → Guide
    expect((document.querySelector('a[href="/guide"]') as Element).getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('a[href="/"]')!.hasAttribute("aria-current")).toBe(false);
    expect(document.title).toBe("Guide");
    expect(location.pathname).toBe("/guide");
  });

  test("guard: segment-scoped fragment with no live outlet does not morph the root", async () => {
    document.body.innerHTML =
      '<div data-june-root><nav data-sidebar><a href="/x">X</a></nav><main data-page="keep">keep</main></div>';
    const root = document.querySelector("[data-june-root]")!;

    // server says segment-scoped, but the DOM has NO [data-june-outlet]
    globalThis.fetch = (async () =>
      new Response('<main data-page="swapped">swapped</main>', {
        headers: { [SEGMENT_HEADER]: "1" },
      })) as unknown as typeof fetch;

    clickLink("/x");
    await flush();

    // no outlet → router bailed to a hard navigation; the root was NOT morphed
    expect(root.innerHTML).toContain('data-page="keep"');
    expect(root.innerHTML).not.toContain('data-page="swapped"');
  });
});
