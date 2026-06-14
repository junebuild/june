// The client half of the islands contract: prove a server-rendered marker
// actually comes alive after hydration. Needs a DOM — bun:test has none, so we
// register happy-dom globally for this file (scoped: registered in beforeAll,
// torn down in afterAll, so the pure tests keep running DOM-free).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

import { act, useState } from "react";
// renderToString (NOT renderToStaticMarkup): hydration needs the text-boundary
// `<!-- -->` markers it emits — without them React sees a mismatch and recreates
// the DOM, which is exactly what islands must NOT do.
import { renderToString } from "react-dom/server";
import { Island } from "@junejs/core/islands";
import { hydrateIslands } from "@junejs/core/islands-client";

// `act()` is how React wants tests to flush hydration + state updates; without
// it the scheduler's MessageChannel work bleeds across test boundaries.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A real interactive island: state + a click handler. Server-rendered it is
// inert markup; the whole point of hydration is that the button starts counting.
function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}

describe("hydrateIslands", () => {
  test("hydrates a server-rendered marker so it becomes interactive", async () => {
    document.body.innerHTML = renderToString(
      <Island name="Counter" component={Counter} props={{ initial: 3 }} />,
    );
    // SSR markup is present and inert before hydration.
    expect(document.body.querySelector("button")!.textContent).toBe("count: 3");

    let count = 0;
    await act(async () => {
      count = hydrateIslands({ Counter });
    });
    expect(count).toBe(1);

    await act(async () => {
      document.body.querySelector("button")!.click();
    });
    expect(document.body.querySelector("button")!.textContent).toBe("count: 4");
  });

  test("dev push-HMR hook: __juneLiveReload morphs the fragment, island state survives", async () => {
    // a clientRouter page: [data-june-root] around a counter island + static content
    document.body.innerHTML =
      '<div data-june-root><h1>v1</h1>' +
      renderToString(<Island name="Counter" component={Counter} props={{ initial: 5 }} />) +
      "</div>";
    await act(async () => {
      hydrateIslands({ Counter });
    });
    // drive the counter up — so we can prove its runtime state survives the HMR
    await act(async () => {
      document.querySelector("button")!.click(); // 5 → 6
    });
    expect(document.querySelector("button")!.textContent).toBe("count: 6");

    const hot = (window as unknown as { __juneLiveReload?: () => Promise<boolean> }).__juneLiveReload;
    expect(typeof hot).toBe("function");

    // the server re-rendered after an edit: <h1> changed; the island marker is inert
    // with a DIFFERENT initial prop (which must NOT clobber the live state)
    const fragment =
      "<h1>v2 EDITED</h1>" +
      renderToString(<Island name="Counter" component={Counter} props={{ initial: 999 }} />);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(fragment, {
        headers: { "content-type": "text/html", "x-june-title": "Edited" },
      })) as unknown as typeof fetch;

    let ok = false;
    await act(async () => {
      ok = await hot!();
    });
    globalThis.fetch = origFetch;

    expect(ok).toBe(true);
    expect(document.querySelector("h1")!.textContent).toBe("v2 EDITED"); // static morphed in
    expect(document.querySelector("button")!.textContent).toBe("count: 6"); // state survived (not 999/5)
    expect(document.title).toBe("Edited");
    // this test booted the client router — clear the once-guard + hook so it can't
    // leak into other suites' routers (the boot is idempotent on __juneRouter).
    const w = window as unknown as { __juneRouter?: boolean; __juneLiveReload?: unknown };
    delete w.__juneRouter;
    delete w.__juneLiveReload;
    document.body.innerHTML = "";
  });

  test("hydrates multiple islands independently", async () => {
    document.body.innerHTML =
      renderToString(<Island name="Counter" component={Counter} props={{ initial: 0 }} />) +
      renderToString(<Island name="Counter" component={Counter} props={{ initial: 10 }} />);

    let count = 0;
    await act(async () => {
      count = hydrateIslands({ Counter });
    });
    expect(count).toBe(2);

    const [a, b] = [...document.body.querySelectorAll("button")];
    await act(async () => {
      a!.click();
    });
    // Clicking the first leaves the second untouched — separate roots, separate state.
    expect(a!.textContent).toBe("count: 1");
    expect(b!.textContent).toBe("count: 10");
  });

  test("skips an island with no registry entry without throwing", async () => {
    document.body.innerHTML = renderToString(
      <Island name="Missing" component={Counter} props={{ initial: 1 }} />,
    );
    // No entry for "Missing" → hydrate nothing, leave the SSR markup in place.
    let count = -1;
    await act(async () => {
      count = hydrateIslands({ Counter });
    });
    expect(count).toBe(0);
    expect(document.body.querySelector("button")!.textContent).toBe("count: 1");
  });
});
