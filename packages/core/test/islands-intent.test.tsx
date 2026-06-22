// PoC intent-based islands: prove the target authoring surface actually runs —
// direct <Counter/> usage, per-usage intent, client-only mount, and a server slot.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

import { act, useEffect, useRef, useState } from "react";
import { renderToString } from "react-dom/server";
import { island, Tab } from "@junejs/core/islands";
import { hydrateIslandsAuto, type SlotProps } from "@junejs/core/islands-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function CounterImpl({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
const Counter = island(CounterImpl, { name: "PocCounter" });

function TabsImpl({ __slot = [] }: SlotProps) {
  const [active, setActive] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (el && __slot[active]) el.replaceChildren(__slot[active]);
  }, [active, __slot]);
  return (
    <div>
      <button type="button" onClick={() => setActive(1)}>
        go
      </button>
      <div ref={host} />
    </div>
  );
}
const Tabs = island(TabsImpl, { name: "PocTabs", slot: true });

describe("poc intent-based islands", () => {
  test("direct <Counter/> usage hydrates with no hand-written registry", async () => {
    document.body.innerHTML = renderToString(<Counter initial={3} />);
    expect(document.body.querySelector("button")!.textContent).toBe("count: 3");
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

  test('client:only ships an empty marker and mounts fresh on the client', async () => {
    const html = renderToString(<Counter initial={9} client:only />);
    expect(html).toContain('data-june-strategy="only"');
    expect(html).not.toContain("count: 9"); // never SSR'd
    document.body.innerHTML = html;
    await act(async () => {
      hydrateIslandsAuto();
    });
    expect(document.body.querySelector("button")!.textContent).toBe("count: 9");
  });

  test("client:<strategy> directive sets the marker strategy and is stripped from props", () => {
    const html = renderToString(<Counter initial={5} client:visible />);
    expect(html).toContain('data-june-strategy="visible"');
    // The directive must NOT leak into the serialized props or onto the DOM.
    expect(html).not.toContain("client:visible");
    expect(html).toContain("count: "); // visible islands ARE server-rendered (text-boundary aside)
    expect(html).toContain("5</button>");
  });

  test("server-slot <Tabs> adopts the SSR panels into an interactive shell", async () => {
    document.body.innerHTML = renderToString(
      <Tabs>
        <Tab title="A">
          <p>alpha</p>
        </Tab>
        <Tab title="B">
          <p>beta</p>
        </Tab>
      </Tabs>,
    );
    // Both panels are server-rendered (graceful no-JS view).
    expect(document.body.textContent).toContain("alpha");
    expect(document.body.textContent).toContain("beta");
    await act(async () => {
      hydrateIslandsAuto();
    });
    // After mount the shell shows the first adopted panel.
    expect(document.body.textContent).toContain("alpha");
    await act(async () => {
      document.body.querySelector("button")!.click();
    });
    expect(document.body.textContent).toContain("beta");
  });
});
