// Segment-scoped client navigation: a soft-nav whose fragment carries a shell
// KEY (x-june-segment) morphs into the live [data-june-outlet] ONLY when that key
// matches the mounted shell ([data-june-root]'s data-june-shell). It leaves the
// shell untouched and reconciles its active-nav highlight from location.pathname.
// A cross-shell key, or a missing outlet, hard-navigates rather than corrupting
// the page.
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

const fragment = (html: string, headers: Record<string, string>) =>
  (async () => new Response(html, { headers })) as unknown as typeof fetch;

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

// A docs shell (key "docs") with a sidebar and an outlet holding the home page.
const docsShell = (outletInner: string) =>
  '<div data-june-root data-june-shell="docs">' +
  '<nav data-sidebar>' +
  '<a href="/" aria-current="page">Home</a>' +
  '<a href="/guide">Guide</a>' +
  '<a href="/blog/post">Blog</a>' +
  "</nav>" +
  `<div data-june-outlet>${outletInner}</div>` +
  "</div>";

describe("segment-scoped client navigation", () => {
  test("matching shell key: morphs the outlet, leaves the shell, moves aria-current", async () => {
    document.body.innerHTML = docsShell('<main><h1 data-page="home">Home</h1></main>');
    const sidebar = document.querySelector("[data-sidebar]")!;
    globalThis.fetch = fragment('<main><h1 data-page="guide">Guide</h1></main>', {
      [SEGMENT_HEADER]: "docs", // same shell key as the mounted [data-june-shell]
      [TITLE_HEADER]: "Guide",
    });

    clickLink("/guide");
    await flush();

    expect(document.querySelector("[data-june-outlet]")!.innerHTML).toContain('data-page="guide"');
    expect(document.querySelector("[data-sidebar]")).toBe(sidebar); // shell untouched (same node)
    expect(document.querySelector('a[href="/guide"]')!.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('a[href="/"]')!.hasAttribute("aria-current")).toBe(false);
    expect(document.title).toBe("Guide");
    expect(location.pathname).toBe("/guide");
  });

  test("ancestor link stays highlighted (section match) on a nested soft-nav", async () => {
    // Sidebar has a section link (/guide) and a nested page link (/guide/faq).
    document.body.innerHTML =
      '<div data-june-root data-june-shell="docs">' +
      '<nav data-sidebar><a href="/guide">Guide</a><a href="/guide/faq">FAQ</a></nav>' +
      '<div data-june-outlet><main data-page="guide">g</main></div>' +
      "</div>";
    history.replaceState({}, "", "/guide");
    globalThis.fetch = fragment('<main data-page="faq">f</main>', { [SEGMENT_HEADER]: "docs" });

    clickLink("/guide/faq");
    await flush();

    // /guide is an ANCESTOR of /guide/faq → stays active ("true"); the exact page link is "page".
    expect(document.querySelector('a[href="/guide"]')!.getAttribute("aria-current")).toBe("true");
    expect(document.querySelector('a[href="/guide/faq"]')!.getAttribute("aria-current")).toBe("page");
  });

  test("cross-shell key: hard-navigates instead of morphing the wrong shell", async () => {
    document.body.innerHTML = docsShell('<main><h1 data-page="home">keep</h1></main>');
    const outlet = document.querySelector("[data-june-outlet]")!;
    globalThis.fetch = fragment('<main data-page="blog">blog</main>', {
      [SEGMENT_HEADER]: "blog", // DIFFERENT shell than the mounted "docs"
    });

    clickLink("/blog/post");
    await flush();

    // key mismatch → no morph into the docs outlet (blog content must NOT land here)
    expect(outlet.innerHTML).toContain('data-page="home"');
    expect(outlet.innerHTML).not.toContain('data-page="blog"');
  });

  test("guard: segment-scoped fragment with no live outlet does not morph the root", async () => {
    document.body.innerHTML =
      '<div data-june-root data-june-shell="docs"><nav data-sidebar><a href="/x">X</a></nav><main data-page="keep">keep</main></div>';
    const root = document.querySelector("[data-june-root]")!;
    globalThis.fetch = fragment('<main data-page="swapped">swapped</main>', { [SEGMENT_HEADER]: "docs" });

    clickLink("/x");
    await flush();

    expect(root.innerHTML).toContain('data-page="keep"');
    expect(root.innerHTML).not.toContain('data-page="swapped"');
  });
});
