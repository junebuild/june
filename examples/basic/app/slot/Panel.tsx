"use client";
// A SLOT island: an interactive shell that wraps server-rendered content. Because it
// renders {children}, June treats those children as a slot — they stay zero-JS server
// HTML; only this chrome hydrates. (Toggle with `hidden`, not unmount, so the content
// and any nested islands inside it are preserved.)
import { useState, type ReactNode } from "react";

export function Panel({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="panel">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? "▾ Hide details" : "▸ Show details"}
      </button>
      <div hidden={!open}>{children}</div>
    </section>
  );
}
