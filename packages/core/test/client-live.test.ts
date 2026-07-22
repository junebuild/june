// applyLiveUpdate — the live-update applier: morph a server-pushed re-render of the
// CURRENT page into [data-june-root], preserving every live island's state, then
// re-hydrate only the new markers. No history/scroll change.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// JS evaluation on (happy-dom 20 defaults it off) — the script re-execution test
// asserts a real side effect; the other tests are indifferent to the setting.
beforeAll(() => GlobalRegistrator.register({ settings: { enableJavaScriptEvaluation: true } }));
afterAll(() => GlobalRegistrator.unregister());

import { applyLiveUpdate } from "@junejs/core/client-live";

type Live = Element & { __juneHydrated?: boolean };

describe("applyLiveUpdate", () => {
  test("morphs static content while preserving a live island; hydrates new ones", () => {
    document.body.innerHTML =
      '<div data-june-root>' +
      '<h2>count: 3</h2>' +
      '<june-island data-june-island="Clock">LIVE STATE</june-island>' +
      '</div>';
    const root = document.querySelector("[data-june-root]")!;
    const clock = root.querySelector("june-island") as Live;
    clock.__juneHydrated = true; // it's live

    const hydrated: ParentNode[] = [];
    // server re-rendered: the count bumped; a NEW island appeared; the Clock marker
    // is inert in the push (but must NOT replace the live one)
    const ok = applyLiveUpdate(
      '<h2>count: 4</h2>' +
        '<june-island data-june-island="Clock">inert</june-island>' +
        '<june-island data-june-island="New">fresh</june-island>',
      "Updated",
      (r) => hydrated.push(r),
    );

    expect(ok).toBe(true);
    expect(root.querySelector("h2")!.textContent).toBe("count: 4"); // static morphed in place
    expect(root.querySelector('june-island[data-june-island="Clock"]')).toBe(clock); // SAME node
    expect(clock.textContent).toBe("LIVE STATE"); // island interior untouched (opaque) → state survives
    expect(root.querySelector('june-island[data-june-island="New"]')).toBeTruthy(); // added
    expect(document.title).toBe("Updated"); // title from the pushed update
    expect(hydrated).toEqual([root]); // re-hydrate ran on the live region (new markers only)
    document.body.innerHTML = "";
  });

  test("returns false (caller falls back) when there is no live region", () => {
    document.body.innerHTML = "<main>no root here</main>";
    expect(applyLiveUpdate("<p>x</p>", null, () => {})).toBe(false);
    document.body.innerHTML = "";
  });

  test("segment-scoped live update morphs the outlet, NOT the root — the shell survives", () => {
    // A boundary route: the pushed fragment is content-only. Morphing it into the
    // root would delete the sidebar; with the shell key it targets the outlet.
    document.body.innerHTML =
      '<div data-june-root data-june-shell="docs">' +
      "<nav data-sidebar>SIDEBAR</nav>" +
      '<div data-june-outlet><main>count: 1</main></div>' +
      "</div>";
    const sidebar = document.querySelector("[data-sidebar]")!;

    const ok = applyLiveUpdate("<main>count: 2</main>", null, () => {}, "docs");

    expect(ok).toBe(true);
    expect(document.querySelector("[data-june-outlet]")!.textContent).toBe("count: 2"); // content updated
    expect(document.querySelector("[data-sidebar]")).toBe(sidebar); // shell untouched (same node, not wiped)
    document.body.innerHTML = "";
  });

  test("re-executes the pushed fragment's scripts (dev HMR keeps page behaviors alive)", () => {
    // The pushed HTML's scripts are innerHTML-parsed → inert; applyLiveUpdate must
    // rebuild them (same hard-nav parity as a soft navigation) — while a live
    // island's interior stays opaque and its scripts untouched.
    const w = globalThis as typeof globalThis & Record<string, unknown>;
    w.__liveRuns = 0;
    document.body.innerHTML =
      '<div data-june-root>' +
      "<main>v1</main>" +
      '<june-island data-june-island="Live">STATE</june-island>' +
      "</div>";
    const island = document.querySelector("june-island") as Element & { __juneHydrated?: boolean };
    island.__juneHydrated = true;

    document.title = "Old";
    const ok = applyLiveUpdate(
      "<main>v2</main><script>window.__liveRuns++;window.__liveTitle = document.title</script>" +
        '<june-island data-june-island="Live"><script>window.__insideIsland = true</script></june-island>',
      "New",
      () => {},
    );

    expect(ok).toBe(true);
    expect(w.__liveRuns).toBe(1); // region script ran, exactly once
    expect(w.__liveTitle).toBe("New"); // title installed before activation (reload parity)
    expect(document.querySelector("june-island")).toBe(island); // live island reused
    expect(island.textContent).toBe("STATE"); // interior opaque — inert marker ignored
    expect(w.__insideIsland).toBeUndefined();
    document.body.innerHTML = "";
  });
});
