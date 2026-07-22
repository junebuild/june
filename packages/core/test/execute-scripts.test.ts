// The swap-time script activator pair — unit coverage of the invariant the two
// halves enforce together: a fragment script cannot run before activation (in
// ANY DOM implementation — neutralize stamps a non-executable type rather than
// trusting the "already started" flag through importNode), and activation runs
// each one exactly once, in document order, leaving data blocks, opt-outs, and
// island interiors alone.
//
// This file (unlike the other DOM suites) registers happy-dom WITH JavaScript
// evaluation enabled — happy-dom 20 ships it off by default — so the tests can
// assert on real execution side effects, not just node surgery. Notably,
// happy-dom's importNode does NOT preserve script inertness (imported scripts
// execute on insert), which is exactly the implementation drift the pending
// stamp exists to neutralize.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: {
      enableJavaScriptEvaluation: true,
      // Keep `<script src>` tests hermetic — no real fetches for externals.
      disableJavaScriptFileLoading: true,
    },
  }),
);
afterAll(() => GlobalRegistrator.unregister());

import { executeScripts, neutralizeScripts, RUN_ONCE_ATTR } from "../src/execute-scripts";
import { morph } from "@junejs/core/morph";

type W = typeof globalThis & Record<string, unknown>;
const w = globalThis as W;

// The real applier pipeline in miniature: a CONNECTED live target, a fragment
// parsed into a disconnected clone, neutralize → morph → execute.
function swap(target: Element, fragmentHtml: string): void {
  const next = target.cloneNode(false) as Element;
  next.innerHTML = fragmentHtml;
  neutralizeScripts(next);
  morph(target, next);
  executeScripts(target);
}

function liveTarget(html = ""): Element {
  const t = document.createElement("div");
  document.body.appendChild(t);
  t.innerHTML = html;
  return t;
}

describe("neutralize → morph → execute — the invariant", () => {
  test("a fragment's inline script runs exactly once, after the morph", () => {
    const t = liveTarget("<p>old</p>");
    swap(t, "<p>new</p><script>window.__runs = (window.__runs||0)+1</script>");
    expect(t.querySelector("p")!.textContent).toBe("new"); // morph did its job
    expect(w.__runs).toBe(1); // ran once — not zero (inert), not twice (mid-morph + activate)
  });

  test("neutralized scripts cannot run during the morph, even when importNode leaks inertness", () => {
    // Direct probe of the drift: an IMPORTED plain script executes on insert in
    // happy-dom (browsers keep it inert) — the stamp is what makes the swap safe.
    const t = liveTarget();
    const next = t.cloneNode(false) as Element;
    next.innerHTML = "<script>window.__midMorph = true</script>";
    neutralizeScripts(next);
    morph(t, next); // insert happens here; the pending type keeps it dead
    expect(w.__midMorph).toBeUndefined();
    executeScripts(t);
    expect(w.__midMorph).toBe(true); // and activation is what runs it
  });

  test("an IDENTICAL script the morph kept still re-runs (its DOM was replaced)", () => {
    const t = liveTarget();
    const html = "<main>page</main><script>window.__again = (window.__again||0)+1</script>";
    swap(t, html);
    expect(w.__again).toBe(1);
    swap(t, html); // same script text — morph keeps the node, attrs re-stamp it
    expect(w.__again).toBe(2);
  });

  test("multiple scripts run in document order and see earlier DOM", () => {
    const t = liveTarget();
    swap(
      t,
      '<script>window.__order = ["a"]</script>' +
        '<b id="between"></b>' +
        '<script>window.__order.push("b", document.getElementById("between") ? "saw-dom" : "no-dom")</script>',
    );
    expect(w.__order).toEqual(["a", "b", "saw-dom"]);
  });

  test("attributes and type survive the rebuild; externals are re-queued in order", () => {
    const t = liveTarget();
    swap(t, '<script src="/x.js" data-keep="k"></script><script type="module">window.__mod = 1</script>');
    const ext = t.querySelector<HTMLScriptElement>("script[src]")!;
    const mod = t.querySelector<HTMLScriptElement>("script[type=module]")!;
    expect(ext.getAttribute("src")).toBe("/x.js");
    expect(ext.getAttribute("data-keep")).toBe("k");
    expect(ext.async).toBe(false); // rebuilt externals must keep document order
    expect(ext.hasAttribute("type")).toBe(false); // no stamp residue on a typeless script
    expect(mod.getAttribute("type")).toBe("module"); // original type restored
    expect(mod.hasAttribute("data-june-type")).toBe(false); // no stash residue
  });

  test("an authored `async` external keeps it — that script opted into unordered", () => {
    const t = liveTarget();
    swap(t, '<script src="/a.js" async></script>');
    const s = t.querySelector<HTMLScriptElement>("script[src]")!;
    expect(s.hasAttribute("async")).toBe(true);
    expect(s.async).toBe(true); // not forced into the ordered queue
  });

  test(`${RUN_ONCE_ATTR}: restored in place, never run by a swap`, () => {
    const t = liveTarget();
    swap(t, `<script ${RUN_ONCE_ATTR}>window.__optedOut = true</script>`);
    const s = t.querySelector("script")!;
    expect(w.__optedOut).toBeUndefined();
    expect(s.hasAttribute("type")).toBe(false); // stamp removed — clean DOM, still un-run
  });

  test("legacy JavaScript MIME types are classified executable, parameters and all", () => {
    // A hard load runs `application/javascript` (and the rest of the spec's
    // classic-JS essence list) — the swap layer must not misfile them as data
    // blocks. Assert the classification via the stamp (happy-dom's evaluator
    // only runs plain/module scripts, so execution itself can't be observed
    // for these types here).
    const next = document.createElement("div");
    next.innerHTML =
      '<script type="application/javascript">1</script>' +
      '<script type="text/javascript;charset=utf-8">1</script>' +
      '<script type="application/ld+json">{}</script>';
    neutralizeScripts(next);
    const types = Array.from(next.querySelectorAll("script")).map((s) => s.getAttribute("type"));
    expect(types).toEqual(["text/x-june-pending", "text/x-june-pending", "application/ld+json"]);

    // ...and activation restores the original type with no stamp residue.
    const t = liveTarget();
    swap(t, '<script type="application/javascript">window.__legacy = 1</script>');
    const s = t.querySelector("script")!;
    expect(s.getAttribute("type")).toBe("application/javascript");
    expect(s.hasAttribute("data-june-type")).toBe(false);
  });

  test("data blocks (JSON-LD and friends) are left completely alone", () => {
    const t = liveTarget();
    const next = t.cloneNode(false) as Element;
    next.innerHTML = '<script type="application/ld+json">{"@type":"Thing"}</script>';
    neutralizeScripts(next);
    const parsed = next.querySelector("script")!;
    expect(parsed.getAttribute("type")).toBe("application/ld+json"); // not stamped
    morph(t, next);
    executeScripts(t);
    expect(t.querySelector("script")!.textContent).toBe('{"@type":"Thing"}');
  });

  test("island-interior scripts NEVER run — stamped through the morph, restored un-run", () => {
    const t = liveTarget();
    const next = t.cloneNode(false) as Element;
    next.innerHTML =
      '<june-island data-june-island="A"><script>window.__island = true</script></june-island>' +
      "<script>window.__outside = true</script>";
    neutralizeScripts(next);
    // stamped too: a FRESH island's subtree is imported and connected by the
    // morph — in a drift DOM that would otherwise execute its scripts mid-swap
    expect(next.querySelector("june-island script")!.getAttribute("type")).toBe(
      "text/x-june-pending",
    );
    morph(t, next);
    executeScripts(t);
    expect(w.__island).toBeUndefined(); // never ran — not mid-morph, not at activation
    const inner = t.querySelector("june-island script")!;
    expect(inner.hasAttribute("type")).toBe(false); // back to its SSR shape pre-rehydration
    expect(inner.hasAttribute("data-june-pending")).toBe(false); // no stamp residue
    expect(w.__outside).toBe(true); // the sibling outside the island ran
  });

  test('an authored EMPTY type round-trips — script[type=""] stays selector-observable', () => {
    const t = liveTarget();
    swap(t, '<script type="">window.__emptyType = (window.__emptyType||0)+1</script>');
    expect(w.__emptyType).toBe(1); // empty type is executable — it ran
    const s = t.querySelector("script")!;
    expect(s.getAttribute("type")).toBe(""); // restored as authored, not stripped
  });

  test("authored markup wearing the sentinel type is never promoted to executable", () => {
    // Only scripts BEARING THE MARKER neutralizeScripts set are activated — a
    // data block that happens to use our sentinel type stays a data block.
    const t = liveTarget();
    swap(t, '<script type="text/x-june-pending">window.__forged = true</script>');
    expect(w.__forged).toBeUndefined();
    expect(t.querySelector("script")!.getAttribute("type")).toBe("text/x-june-pending"); // as authored
  });
});
