"use client";
// The dark ↔ light switch. Dark is the stylesheet default; the no-FOUC inline
// script in the layout already applied a saved choice before paint. This island
// lets the user flip it and persists the choice. Server-renders inert.
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  // adopt whatever the inline script set on <html> (avoids a hydration flip)
  useEffect(() => {
    const cur = document.documentElement.getAttribute("data-theme");
    setTheme(cur === "light" ? "light" : "dark");
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
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Light" : "Dark"}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
