"use client";
// The global "view as" switch — June's content-negotiated surfaces as real
// links. june.build serves every page as text/html, .md, and .json off ONE
// route(), at the SAME clean path + a suffix: "/why" → "/why.md"; the home
// route uses the conventional "/index" stem → "/index.md" / "/index.json". The
// layout can't know the path server-side (layouts get only children), so the
// hrefs are filled from location on hydrate; surfaces are reachable by URL too.
import { useEffect, useState } from "react";

// The projection stem for a path: "/why.md" → "/why"; "/" → "/index" (so the
// home surfaces read as the intuitive /index.md · /index.json).
function routeStem(pathname: string): string {
  const clean = pathname.replace(/\.(md|json)$/, "").replace(/\/+$/, "");
  return clean === "" ? "/index" : clean;
}

export function ViewAs() {
  // human = the canonical page path ("/" for home); stem = the projection base
  // ("/index" for home) so .md/.json read as /index.md · /index.json.
  const [human, setHuman] = useState("/");
  const [stem, setStem] = useState("/index");
  const [active, setActive] = useState<"human" | "md" | "json">("human");

  useEffect(() => {
    const clean = location.pathname.replace(/\.(md|json)$/, "").replace(/\/+$/, "");
    setHuman(clean === "" ? "/" : clean);
    setStem(routeStem(location.pathname));
    const m = location.pathname.match(/\.(md|json)$/);
    setActive(m ? (m[1] as "md" | "json") : "human");
  }, []);

  // "/" → human "/", /index.md, /index.json · "/why" → /why, /why.md, /why.json
  const surfaces = [
    { id: "human" as const, label: "Human", href: human },
    { id: "md" as const, label: ".md", href: stem + ".md" },
    { id: "json" as const, label: ".json", href: stem + ".json" },
  ];

  return (
    <div className="j-viewas">
      <span className="j-viewas-lbl">view as</span>
      <div className="j-seg" role="tablist" aria-label="View this page as">
        {surfaces.map((s) => (
          <a
            key={s.id}
            role="tab"
            aria-selected={active === s.id}
            className={active === s.id ? "is-on" : ""}
            href={s.href}
          >
            {s.label}
          </a>
        ))}
      </div>
    </div>
  );
}
