// applyLiveUpdate — the live-update applier: morph a server-pushed re-render of the
// CURRENT page into [data-june-root], preserving every live island's state, then
// re-hydrate only the new markers. No history/scroll change.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
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
});
