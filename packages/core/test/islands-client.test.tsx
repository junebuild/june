// The client half of the islands contract: prove a server-rendered marker comes
// alive after hydration, and that startJuneClient wires the router + dev HMR with
// a v2-aware rehydrate. Needs a DOM — happy-dom registered for this file.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

import { act, useState } from "react";
// renderToString (NOT renderToStaticMarkup): hydration needs the text-boundary
// `<!-- -->` markers it emits.
import { renderToString } from "react-dom/server";
import { island } from "@junejs/core/islands";
import { hydrateIslandsAuto, startJuneClient } from "@junejs/core/islands-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A real interactive island (island v2): island() self-registers it, so the
// runtime hydrates it with no hand-written registry.
const Counter = island(function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
});

describe("hydrateIslandsAuto", () => {
  test("hydrates a server-rendered marker so it becomes interactive", async () => {
    document.body.innerHTML = renderToString(<Counter initial={3} />);
    expect(document.body.querySelector("button")!.textContent).toBe("count: 3"); // inert SSR

    let n = 0;
    await act(async () => {
      n = hydrateIslandsAuto();
    });
    expect(n).toBe(1);

    await act(async () => {
      document.body.querySelector("button")!.click();
    });
    expect(document.body.querySelector("button")!.textContent).toBe("count: 4");
  });

  test("hydrates multiple islands independently", async () => {
    document.body.innerHTML =
      renderToString(<Counter initial={0} />) + renderToString(<Counter initial={10} />);

    await act(async () => {
      hydrateIslandsAuto();
    });

    const [a, b] = [...document.body.querySelectorAll("button")];
    await act(async () => {
      a!.click();
    });
    // Separate roots, separate state.
    expect(a!.textContent).toBe("count: 1");
    expect(b!.textContent).toBe("count: 10");
  });

  test("skips a marker with no registry entry without throwing", async () => {
    // Hand-crafted marker whose name isn't registered.
    document.body.innerHTML =
      '<june-island data-june-island="Missing" data-june-props="{}" data-june-strategy="load">' +
      "<button>count: 1</button></june-island>";
    await act(async () => {
      hydrateIslandsAuto();
    });
    // No entry → leave the SSR markup in place (graceful, no throw).
    expect(document.body.querySelector("button")!.textContent).toBe("count: 1");
  });
});

describe("startJuneClient (bootstrap)", () => {
  test("dev push-HMR hook: __juneLiveReload morphs the fragment, island state survives", async () => {
    // A clientRouter page: [data-june-root] around an island + static content.
    document.body.innerHTML =
      '<div data-june-root><h1>v1</h1>' + renderToString(<Counter initial={5} />) + "</div>";

    await act(async () => {
      startJuneClient(); // no loaders → eager auto-hydrate; [data-june-root] → router + HMR hook
    });
    // Drive the counter up so we can prove runtime state survives the HMR.
    await act(async () => {
      document.querySelector("button")!.click(); // 5 → 6
    });
    expect(document.querySelector("button")!.textContent).toBe("count: 6");

    const hot = (window as unknown as { __juneLiveReload?: () => Promise<boolean> }).__juneLiveReload;
    expect(typeof hot).toBe("function");

    // The server re-rendered after an edit: <h1> changed; the island marker is inert
    // with a DIFFERENT initial prop (which must NOT clobber the live state).
    const fragment = "<h1>v2 EDITED</h1>" + renderToString(<Counter initial={999} />);
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

    // Clear the router once-guard + hook so it can't leak into other suites.
    const w = window as unknown as { __juneRouter?: boolean; __juneLiveReload?: unknown };
    delete w.__juneRouter;
    delete w.__juneLiveReload;
    document.body.innerHTML = "";
  });
});
