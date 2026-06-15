"use client";
// The global "view as" switch — June's content-negotiated surfaces as real
// links. june.build serves every page as text/html, .md, and .json off ONE
// route(), so this just points at the current path's projections. The layout
// can't know the path server-side (layouts get only children), so the hrefs are
// filled from location on hydrate; .md/.json are always reachable by URL anyway.
import { useEffect, useState } from "react";

const SURFACES = [
  { id: "human", label: "Human", suffix: "" },
  { id: "md", label: ".md", suffix: ".md" },
  { id: "json", label: ".json", suffix: ".json" },
] as const;

// "/why" → base "/why"; "/" → "/index"; strip an existing .md/.json.
function basePath(pathname: string): string {
  const clean = pathname.replace(/\.(md|json)$/, "").replace(/\/+$/, "");
  return clean === "" ? "/index" : clean;
}

export function ViewAs() {
  const [path, setPath] = useState("/index");
  const [active, setActive] = useState<"human" | "md" | "json">("human");

  useEffect(() => {
    setPath(basePath(location.pathname));
    const m = location.pathname.match(/\.(md|json)$/);
    setActive(m ? (m[1] as "md" | "json") : "human");
  }, []);

  return (
    <div className="j-viewas">
      <span className="j-viewas-lbl">view as</span>
      <div className="j-seg" role="tablist" aria-label="View this page as">
        {SURFACES.map((s) => (
          <a
            key={s.id}
            role="tab"
            aria-selected={active === s.id}
            className={active === s.id ? "is-on" : ""}
            href={s.id === "human" ? path.replace(/\/index$/, "/") : path + s.suffix}
          >
            {s.label}
          </a>
        ))}
      </div>
    </div>
  );
}
