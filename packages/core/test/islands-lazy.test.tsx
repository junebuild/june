// PoC code-splitting: prove the lazy runtime downloads ONLY the islands a page
// renders. A loader is a `() => import(chunk)` thunk — here we spy on the thunks
// to assert which chunks a page would fetch, without a real bundler.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

import { act, useState } from "react";
import { renderToString } from "react-dom/server";
import { island } from "@junejs/core/islands";
import { hydrateIslandsLazy } from "@junejs/core/islands-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function CounterImpl({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
const Counter = island(CounterImpl, { name: "LazyCounter" });

function TabsImpl() {
  return <div>tabs</div>;
}
const Tabs = island(TabsImpl, { name: "LazyTabs" });

// Loaders mimic `() => import("./Chunk")`: the import side-effect (island()) has
// already registered the component above, so the thunk just resolves — and
// records that this chunk WOULD have been fetched.
function spyLoaders() {
  const fetched: string[] = [];
  return {
    fetched,
    loaders: {
      LazyCounter: () => {
        fetched.push("Counter.js");
        return Promise.resolve();
      },
      LazyTabs: () => {
        fetched.push("Tabs.js");
        return Promise.resolve();
      },
    },
  };
}

describe("poc code-split lazy islands", () => {
  test("a page fetches only the chunks for the islands it renders", async () => {
    // This page renders ONLY a Counter (like /poc-lite).
    document.body.innerHTML = renderToString(<Counter initial={2} />);
    const { fetched, loaders } = spyLoaders();

    await act(async () => {
      hydrateIslandsLazy(loaders);
    });
    await act(async () => {}); // flush the loader's microtask → mount

    // Counter's chunk was requested; Tabs' chunk was NOT (no marker on the page).
    expect(fetched).toContain("Counter.js");
    expect(fetched).not.toContain("Tabs.js");

    // And it actually came alive.
    await act(async () => {
      document.body.querySelector("button")!.click();
    });
    expect(document.body.querySelector("button")!.textContent).toBe("count: 3");
  });

  test("a page with both islands fetches both chunks", async () => {
    document.body.innerHTML =
      renderToString(<Counter initial={0} />) + renderToString(<Tabs />);
    const { fetched, loaders } = spyLoaders();

    await act(async () => {
      hydrateIslandsLazy(loaders);
    });
    await act(async () => {});

    expect(fetched.sort()).toEqual(["Counter.js", "Tabs.js"]);
  });
});
