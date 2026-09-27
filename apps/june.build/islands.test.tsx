// The home page's client islands, mounted in happy-dom (the packages/core
// store.test.tsx discipline): AskSite's search ordering + dialog name, and
// AgentStage's surface switcher semantics.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// The DOM must exist BEFORE react-dom evaluates: it feature-detects `oninput` on
// `document` at module init, and without it onChange never fires for text inputs.
// Static imports are hoisted above any register() call, so these load dynamically.
GlobalRegistrator.register({ url: "http://june.test/" });
afterAll(() => GlobalRegistrator.unregister());
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentStage } = await import("./app/AgentStage");
const { AskSite } = await import("./app/AskSite");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
const realFetch = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = undefined;
  globalThis.fetch = realFetch;
});

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

// A /mcp stand-in whose responses the test releases one at a time, in any order.
function deferredMcp() {
  const pending = new Map<string, (hits: Array<{ slug: string; title: string; summary: string }>) => void>();
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body));
    const query: string = params.arguments.query;
    const hits = await new Promise<Array<{ slug: string; title: string; summary: string }>>((r) => pending.set(query, r));
    const body = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(hits) }] } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    release: async (query: string, title: string) => {
      await act(async () => {
        pending.get(query)!([{ slug: `docs/${query}`, title, summary: "" }]);
        await new Promise((r) => setTimeout(r, 0));
      });
    },
  };
}

// Type into the controlled input the way React observes it, then submit the form.
async function ask(el: HTMLElement, text: string) {
  const input = el.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("AskSite", () => {
  test("a slow earlier search never overwrites a newer one", async () => {
    const mcp = deferredMcp();
    const el = await mount(<AskSite variant="inline" />);

    await ask(el, "first");
    await ask(el, "second");
    await mcp.release("second", "Second result"); // the newer query answers first…
    await mcp.release("first", "First result"); //   …then the stale one lands

    const titles = [...el.querySelectorAll(".j-ask-hit b")].map((b) => b.textContent);
    expect(titles).toEqual(["Second result"]);
    expect(el.textContent).toContain('search_site {"query":"second"}');
  });

  test("the ⌘K dialog has an accessible name", async () => {
    const el = await mount(<AskSite />);
    expect(el.querySelector("dialog")!.getAttribute("aria-label")).toBe("Ask this site");
  });
});

describe("AgentStage", () => {
  const rows = (el: HTMLElement) => el.querySelectorAll(".j-stage-body > div").length;
  const button = (el: HTMLElement, text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>(".j-stage-replay")].find((b) => b.textContent!.includes(text));

  test("the auto-playing turn can be stopped: skip shows it whole, and nothing updates after", async () => {
    const el = await mount(<AgentStage />);
    expect(rows(el)).toBe(1); // playing: only the first step so far
    await act(async () => button(el, "skip")!.click());
    const whole = rows(el);
    expect(whole).toBe(7); // the full Slack turn, at once

    await act(async () => void (await new Promise((r) => setTimeout(r, 1200)))); // > one step's delay
    expect(rows(el)).toBe(whole); // stopped — no further automatic updates
    expect(button(el, "skip")).toBeUndefined();
    expect(button(el, "replay")).toBeDefined();
  });

  test("a resumed turn runs as its sender: the approver is resume.by, not ctx.user", async () => {
    const el = await mount(<AgentStage />);
    await act(async () => button(el, "skip")!.click());
    const text = el.textContent!;
    expect(text).toContain("resume.by = @maya");
    expect(text).toContain("ctx.user = U04DANA");
    expect(text).not.toContain("U04MAYA");
  });

  test("the surface switcher is a labeled toggle-button group, not a partial tabs widget", async () => {
    const el = await mount(<AgentStage />);
    const group = el.querySelector('[aria-label="Surface"]')!;
    expect(group.getAttribute("role")).toBe("group");
    expect(el.querySelector('[role="tab"], [role="tablist"]')).toBeNull();

    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Slack", "true"],
      ["Crisp", "false"],
      ["/mcp", "false"],
    ]);

    await act(async () => buttons[1]!.click());
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  });
});
