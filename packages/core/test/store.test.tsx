// Cross-island store: state shared across SEPARATE React roots (the island case).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

import { act, createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { createStore, useStore } from "@junejs/core/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createStore", () => {
  test("get / set (value + updater) / subscribe + unsubscribe", () => {
    const s = createStore(0);
    const seen: number[] = [];
    const off = s.subscribe(() => seen.push(s.get()));
    s.set(1);
    s.set((n) => n + 1);
    s.set(2); // identical → no notify
    off();
    s.set(9); // after unsubscribe → not seen
    expect(seen).toEqual([1, 2]);
    expect(s.get()).toBe(9);
  });
});

describe("useStore across separate island roots", () => {
  test("updating from one island re-renders another that shares the store", async () => {
    const cart = createStore<string[]>([]);
    function Badge() {
      const [items] = useStore(cart);
      return h("span", { className: "badge" }, `cart: ${items.length}`);
    }
    function Add() {
      const [, set] = useStore(cart);
      return h("button", { className: "add", onClick: () => set((c) => [...c, "x"]) }, "add");
    }
    // Two markers, hydrated as INDEPENDENT roots — the cross-island case.
    document.body.innerHTML = `<div id="b">${renderToString(h(Badge))}</div><div id="a">${renderToString(h(Add))}</div>`;
    expect(document.querySelector(".badge")!.textContent).toBe("cart: 0"); // SSR snapshot = initial
    await act(async () => {
      hydrateRoot(document.getElementById("b")!, h(Badge));
      hydrateRoot(document.getElementById("a")!, h(Add));
      await flush();
    });
    await act(async () => {
      document.querySelector<HTMLElement>(".add")!.click();
    });
    expect(document.querySelector(".badge")!.textContent).toBe("cart: 1"); // the OTHER root updated
  });

  test("a selector re-renders only when its slice changes", async () => {
    const store = createStore({ count: 0, name: "june" });
    let renders = 0;
    function CountView() {
      const [count] = useStore(store, (s) => s.count);
      renders++;
      return h("span", { className: "c" }, String(count));
    }
    document.body.innerHTML = `<div id="c">${renderToString(h(CountView))}</div>`;
    await act(async () => {
      hydrateRoot(document.getElementById("c")!, h(CountView));
      await flush();
    });
    const base = renders;
    await act(async () => {
      store.set((s) => ({ ...s, name: "kura" })); // unrelated slice
      await flush();
    });
    expect(renders).toBe(base); // selector unchanged → no re-render
    await act(async () => {
      store.set((s) => ({ ...s, count: 1 })); // selected slice
      await flush();
    });
    expect(renders).toBe(base + 1);
    expect(document.querySelector(".c")!.textContent).toBe("1");
  });
});
