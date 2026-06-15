"use client";
// The hero centerpiece: one route() projected as Human / .md / .json / /mcp.
// Tabs switch the surface; the /mcp tab plays a short, restrained agent session
// (tools/list → tools/call → streamed result), honoring prefers-reduced-motion.
// Server-renders showing the Human surface; hydration enables the tabs.
import { useEffect, useRef, useState } from "react";

const POINTS = [
  { k: "01", h: "One definition, four surfaces", b: "HTML to people; .md, .json, and /mcp to agents — derived, never maintained by hand." },
  { k: "02", h: "No glue layer", b: "Auth, data, and agents are one model. run(input, ctx) is the only gate." },
  { k: "03", h: "Data magic", b: "Writes auto-invalidate the cache; reads auto-batch into one query." },
];

const TABS = [
  { id: "human", label: "Human", live: false },
  { id: "md", label: ".md", live: false },
  { id: "json", label: ".json", live: false },
  { id: "mcp", label: "/mcp", live: true },
] as const;

function HumanProjection() {
  return (
    <div className="j-mini">
      <div className="j-mini-wm">June</div>
      <p className="j-mini-tag">The opinionated, agent-ready React framework.</p>
      {POINTS.map((p) => (
        <div key={p.k} className="j-mini-row">
          <span className="j-mini-k">{p.k}</span>
          <div>
            <div className="j-mini-h">{p.h}</div>
            <p className="j-mini-p">{p.b}</p>
          </div>
        </div>
      ))}
      <div className="j-mini-cta">npm create june@latest →</div>
    </div>
  );
}

function MdProjection() {
  return (
    <pre className="j-code">
      <span className="tk-hd"># June</span>{"\n\n"}
      **The opinionated, agent-ready React framework.**{"\n\n"}
      One <span className="tk-tag">`route()`</span> is a page, a JSON API,{"\n"}an MCP server, and an{" "}
      <span className="tk-tag">`llms.txt`</span> entry.{"\n\n"}
      <span className="tk-mut">- </span>**One definition, four surfaces**{"\n"}
      <span className="tk-mut">- </span>**No glue layer** — auth, data, agents are{"\n"}{"  "}ONE model.{"\n"}
      <span className="tk-mut">- </span>**Agents as scoped users** — same auth gate.{"\n"}
      <span className="tk-mut">- </span>**Data magic** — writes auto-invalidate;{"\n"}{"  "}reads auto-batch.{"\n\n"}
      <span className="tk-mut">$ </span>npm create <span className="tk-tag">june@latest</span> my-app
    </pre>
  );
}

function JsonProjection() {
  return (
    <pre className="j-code">
      {"{"}{"\n"}
      {"  "}<span className="tk-key">"title"</span>: <span className="tk-str">"June — the agent-ready React framework"</span>,{"\n"}
      {"  "}<span className="tk-key">"summary"</span>: <span className="tk-str">"One route() is a page, a JSON</span>{"\n"}
      {"    "}<span className="tk-str">API, an MCP server, and an llms.txt entry."</span>,{"\n"}
      {"  "}<span className="tk-key">"surfaces"</span>: [{"\n"}
      {"    "}<span className="tk-str">"text/html"</span>, <span className="tk-str">"application/json"</span>,{"\n"}
      {"    "}<span className="tk-str">"text/markdown"</span>, <span className="tk-str">"mcp"</span>{"\n"}
      {"  "}],{"\n"}
      {"  "}<span className="tk-key">"install"</span>: <span className="tk-str">"npm create june@latest my-app"</span>,{"\n"}
      {"  "}<span className="tk-key">"status"</span>: <span className="tk-str">"0.0.x preview"</span>{"\n"}
      {"}"}
    </pre>
  );
}

function McpProjection({ active }: { active: boolean }) {
  const reduce = useRef(false);
  const [step, setStep] = useState(0);
  useEffect(() => {
    reduce.current =
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!active) return;
    if (reduce.current) {
      setStep(9);
      return;
    }
    setStep(0);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setStep(n);
      if (n >= 9) clearInterval(id);
    }, 520);
    return () => clearInterval(id);
  }, [active]);

  return (
    <div className="j-mcp">
      <div className="j-mcp-status">
        <span className="j-pulse" />agent session · /mcp · scoped as user_42
      </div>
      {step >= 1 && (
        <div className="j-mcp-line">
          <span className="j-mcp-prompt">› </span>
          <span className="j-mcp-cmd">tools/list</span>
        </div>
      )}
      {step >= 2 && (
        <div className="j-mcp-chips">
          {["search_site", "get_page", "createUser"].map((t) => (
            <span key={t} className="j-mcp-chip">
              <span className="d" />
              {t}
            </span>
          ))}
        </div>
      )}
      {step >= 3 && (
        <div className="j-mcp-line">
          <span className="j-mcp-prompt">› </span>
          <span className="j-mcp-cmd">tools/call search_site </span>
          {"{"}
          <span className="j-mcp-key">"q"</span>: <span className="j-mcp-str">"cold start"</span>
          {"}"}
          <span className="j-mcp-note">  · auth ✓</span>
        </div>
      )}
      {step >= 4 && (
        <div className="j-mcp-out">
          3 hits · top: <span style={{ color: "var(--agent-cyan)" }}>"59ms: anatomy of a dev cold start"</span>
        </div>
      )}
      {step >= 5 && (
        <div className="j-mcp-line">
          <span className="j-mcp-prompt">› </span>
          <span className="j-mcp-cmd">tools/call get_page </span>
          {"{"}
          <span className="j-mcp-key">"slug"</span>: <span className="j-mcp-str">"anatomy-of-a-59ms-cold-start"</span>
          {"}"}
        </div>
      )}
      {step >= 6 && (
        <div className="j-mcp-out">
          Streaming markdown — the three cuts were listen-early, a V8 startup snapshot, and bundling React vendors into the module map
          {step < 8 && <span className="j-mcp-cursor" />}
        </div>
      )}
      {step >= 8 && (
        <div className="j-mcp-step">
          — <b>done</b> · 2 tool calls · 71ms · text/markdown · one auth gate
        </div>
      )}
    </div>
  );
}

export function HeroViewer() {
  const [tab, setTab] = useState<"human" | "md" | "json" | "mcp">("human");
  return (
    <div className="j-viewer">
      <div className="j-viewer-bar">
        <div className="j-viewer-route">
          <b>route()</b> · /
        </div>
        <div className="j-viewer-tabs" role="tablist" aria-label="Surface">
          {TABS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={tab === s.id}
              className={"j-viewer-tab" + (tab === s.id ? " is-on" : "")}
              onClick={() => setTab(s.id)}
            >
              {s.live && <span className="j-livedot" />}
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="j-viewer-body">
        {tab === "human" && <HumanProjection />}
        {tab === "md" && <MdProjection />}
        {tab === "json" && <JsonProjection />}
        {tab === "mcp" && <McpProjection active={tab === "mcp"} />}
      </div>
    </div>
  );
}
