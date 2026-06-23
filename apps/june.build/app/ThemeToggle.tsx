"use client";
// The warm-light ↔ dark-agentic switch. The no-FOUC inline script in the layout
// already applied the saved theme before paint; this island just lets the user
// flip it and persists the choice. Server-renders inert; hydration wires it.
import { useEffect, useState } from "react";
import { island } from "@junejs/core/islands";

function ThemeToggleImpl() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // adopt whatever the inline script set on <html> (avoids a hydration flip)
  useEffect(() => {
    const cur = document.documentElement.getAttribute("data-theme");
    setTheme(cur === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("june-theme", next);
    } catch {
      /* private mode — the in-memory flip still works for this session */
    }
  };

  return (
    <button
      type="button"
      className="j-themetoggle"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to warm light" : "Switch to dark agentic"}
      title={theme === "dark" ? "Warm light" : "Dark agentic"}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

export const ThemeToggle = island(ThemeToggleImpl, { name: "ThemeToggle" });
