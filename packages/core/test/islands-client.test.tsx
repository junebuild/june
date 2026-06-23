/** @jsxImportSource @junejs/core */
// The client hydration runtime over the new model: markers are produced by the JSX
// runtime (plain components + client:*), loaders resolve the component, hydrateIslands
// brings them to life. startJuneClient wires the router + dev HMR.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3000/" }));
afterAll(() => GlobalRegistrator.unregister());

import { act, useState } from "react";
import { renderToString } from "react-dom/server";
import { hydrateIslands, startJuneClient } from "@junejs/core/islands-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A PLAIN "use client" component — no island() wrapper.
function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
const loaders = { Counter: () => Promise.resolve(Counter) };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("hydrateIslands", () => {
  test("hydrates a marker so it becomes interactive", async () => {
    document.body.innerHTML = renderToString(<Counter initial={3} client:load />);
    expect(document.body.querySelector("button")!.textContent).toBe("count: 3"); // inert SSR
    await act(async () => {
      hydrateIslands(loaders);
      await flush();
    });
    await act(async () => {
      document.body.querySelector("button")!.click();
    });
    expect(document.body.querySelector("button")!.textContent).toBe("count: 4");
  });

  test("warns + skips a marker with no loader (no throw)", async () => {
    document.body.innerHTML = renderToString(<Counter initial={1} client:load />);
    await act(async () => {
      hydrateIslands({}); // empty registry
      await flush();
    });
    expect(document.body.querySelector("button")!.textContent).toBe("count: 1"); // intact, unhydrated
  });
});

describe("startJuneClient (bootstrap)", () => {
  test("dev push-HMR hook: __juneLiveReload morphs the fragment, island state survives", async () => {
    document.body.innerHTML =
      '<div data-june-root><h1>v1</h1>' + renderToString(<Counter initial={5} client:load />) + "</div>";
    await act(async () => {
      startJuneClient({ loaders });
      await flush();
    });
    await act(async () => {
      document.querySelector("button")!.click(); // 5 → 6
    });
    expect(document.querySelector("button")!.textContent).toBe("count: 6");

    const hot = (window as unknown as { __juneLiveReload?: () => Promise<boolean> }).__juneLiveReload;
    expect(typeof hot).toBe("function");

    const fragment = "<h1>v2 EDITED</h1>" + renderToString(<Counter initial={999} client:load />);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(fragment, {
        headers: { "content-type": "text/html", "x-june-title": "Edited" },
      })) as unknown as typeof fetch;

    let ok = false;
    await act(async () => {
      ok = await hot!();
      await flush();
    });
    globalThis.fetch = origFetch;

    expect(ok).toBe(true);
    expect(document.querySelector("h1")!.textContent).toBe("v2 EDITED"); // static morphed in
    expect(document.querySelector("button")!.textContent).toBe("count: 6"); // state survived

    const w = window as unknown as { __juneRouter?: boolean; __juneLiveReload?: unknown };
    delete w.__juneRouter;
    delete w.__juneLiveReload;
    document.body.innerHTML = "";
  });
});
