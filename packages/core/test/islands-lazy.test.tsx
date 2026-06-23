/** @jsxImportSource @junejs/core */
// Code-splitting: a page only loads the chunks for the islands it renders. The
// loaders are spied so we can assert which chunks would be fetched.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

import { act, useState } from "react";
import { renderToString } from "react-dom/server";
import { hydrateIslands } from "@junejs/core/islands-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
function Tabs() {
  return <div>tabs</div>;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function spyLoaders() {
  const fetched: string[] = [];
  return {
    fetched,
    loaders: {
      Counter: () => {
        fetched.push("Counter");
        return Promise.resolve(Counter);
      },
      Tabs: () => {
        fetched.push("Tabs");
        return Promise.resolve(Tabs);
      },
    },
  };
}

describe("code-split island loading", () => {
  test("a page fetches only the chunks for the islands it renders", async () => {
    document.body.innerHTML = renderToString(<Counter initial={2} client:load />); // only Counter
    const { fetched, loaders } = spyLoaders();
    await act(async () => {
      hydrateIslands(loaders);
      await flush();
    });
    expect(fetched).toContain("Counter");
    expect(fetched).not.toContain("Tabs");
    await act(async () => {
      document.body.querySelector("button")!.click();
    });
    expect(document.body.querySelector("button")!.textContent).toBe("count: 3");
  });

  test("a page with both islands fetches both chunks", async () => {
    document.body.innerHTML =
      renderToString(<Counter initial={0} client:load />) + renderToString(<Tabs client:load />);
    const { fetched, loaders } = spyLoaders();
    await act(async () => {
      hydrateIslands(loaders);
      await flush();
    });
    expect(fetched.sort()).toEqual(["Counter", "Tabs"]);
  });
});
