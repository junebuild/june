// The Route A morph applier — unit coverage of the behaviors that make it a morph
// and not a replace: static nodes keep identity (focus/value survive), islands are
// opaque (interiors untouched), persistent live islands are reused, others come
// fresh, and children add/remove correctly.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

import { morph } from "@junejs/core/morph";

// Parse `html` into a detached element (the morph target/source).
const el = (html: string): Element => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
};
type Live = Element & { __juneHydrated?: boolean };
const island = (e: Element): Live => e.querySelector("june-island") as Live;

describe("morph — static nodes keep identity", () => {
  test("an unchanged input keeps its node, value, and focus", () => {
    const old = el('<p>hi</p><input id="a"><p>bye</p>');
    document.body.append(...Array.from(old.childNodes)); // connect so focus works
    const root = document.body;
    const input = root.querySelector("input") as HTMLInputElement;
    input.value = "typed by the user";
    input.focus();

    morph(root, el('<p>HELLO</p><input id="a"><p>bye</p>') as Element);

    expect(root.querySelector("input")).toBe(input); // SAME node, not rebuilt
    expect(input.value).toBe("typed by the user"); // live value survived
    expect(document.activeElement).toBe(input); // focus survived
    expect(root.querySelector("p")!.textContent).toBe("HELLO"); // text morphed in place
    document.body.innerHTML = "";
  });

  test("attributes sync: added, changed, removed", () => {
    const old = el('<a href="/old" class="x" data-stale="1">link</a>');
    morph(old, el('<a href="/new" class="x y">link</a>') as Element);
    const a = old.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/new"); // changed
    expect(a.getAttribute("class")).toBe("x y"); // changed
    expect(a.hasAttribute("data-stale")).toBe(false); // removed
  });

  test("children added and removed", () => {
    const old = el("<ul><li>a</li><li>b</li></ul>");
    morph(old, el("<ul><li>a</li><li>B</li><li>c</li></ul>") as Element);
    const items = Array.from(old.querySelectorAll("li")).map((l) => l.textContent);
    expect(items).toEqual(["a", "B", "c"]);

    const old2 = el("<ul><li>a</li><li>b</li><li>c</li></ul>");
    morph(old2, el("<ul><li>a</li></ul>") as Element);
    expect(old2.querySelectorAll("li").length).toBe(1);
  });
});

describe("morph — islands are opaque", () => {
  test("a persistent live island is REUSED, its interior untouched", () => {
    const old = el(
      '<june-island data-june-island="Live" data-june-persist><span>LIVE STATE</span></june-island>',
    );
    const live = island(old);
    live.__juneHydrated = true;

    // the new fragment carries an INERT marker with different interior markup
    morph(
      old,
      el(
        '<june-island data-june-island="Live" data-june-persist><span>inert ssr</span></june-island>',
      ) as Element,
    );

    expect(island(old)).toBe(live); // the SAME live node survived
    expect(island(old).querySelector("span")!.textContent).toBe("LIVE STATE"); // interior NOT touched
  });

  test("a non-persistent island is taken fresh (re-hydrated by the caller)", () => {
    const old = el('<june-island data-june-island="C"><span>old</span></june-island>');
    (island(old) as Live).__juneHydrated = true;
    morph(old, el('<june-island data-june-island="C"><span>new</span></june-island>') as Element);
    const after = island(old);
    expect(after.querySelector("span")!.textContent).toBe("new"); // fresh marker
    expect((after as Live).__juneHydrated).toBeUndefined(); // a fresh node → caller hydrates it
  });

  test("a persistent island survives even when its slot shifts (matched by name)", () => {
    const old = el(
      '<june-island data-june-island="Live" data-june-persist>X</june-island><h1>old</h1>',
    );
    const live = island(old);
    live.__juneHydrated = true;
    // new order: heading first, then the island
    morph(
      old,
      el('<h1>new</h1><june-island data-june-island="Live" data-june-persist>Y</june-island>') as Element,
    );
    expect(island(old)).toBe(live); // same live node, reused into its new slot
    expect(island(old).textContent).toBe("X"); // interior preserved
    expect(old.querySelector("h1")!.textContent).toBe("new");
  });
});
