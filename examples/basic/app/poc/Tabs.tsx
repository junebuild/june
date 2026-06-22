"use client";
// PoC slot island: <Tabs><Tab title="…">server content</Tab></Tabs>.
// The server renders ONLY the <Tab> panels (light DOM); this client shell adopts
// them, builds the tab buttons from their titles, and shows one at a time.
//
// The inner function is a NAMED EXPRESSION `Tabs` (self-scoped name, no clash
// with the export const) so its runtime island name == the export name the auto
// registry keys by — no explicit { name } needed.
import { useEffect, useRef, useState } from "react";

import { island, type Strategy } from "@junejs/core/poc-islands";
import type { SlotProps } from "@junejs/core/poc-islands-client";

// Strategy is re-exported only so the page can type `client` overrides if needed.
export type { Strategy };

export const Tabs = island(
  function Tabs({ __slot = [] }: SlotProps) {
    const panels = __slot;
    const titles = panels.map((n) => n.getAttribute("data-june-tab") ?? "");
    const [active, setActive] = useState(0);
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const el = host.current;
      const panel = panels[active];
      if (el && panel) el.replaceChildren(panel); // moves the adopted node in
    }, [active, panels]);

    return (
      <div>
        <div role="tablist" style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          {titles.map((t, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              style={{ fontWeight: i === active ? 700 : 400 }}
            >
              {t}
            </button>
          ))}
        </div>
        <div ref={host} />
      </div>
    );
  },
  { slot: true },
);
