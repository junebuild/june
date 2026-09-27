"use client";
// "Ask this site" — the site dogfooding its own agent surface. The query goes to
// THIS site's /mcp as a real JSON-RPC tools/call of search_site (app/actions.ts),
// the same tool any external agent sees; the panel shows the call it made and
// the cards it got back. Two variants: the nav button + ⌘K dialog (default), and
// an inline panel for the home page.
import { useEffect, useRef, useState } from "react";

type Hit = { slug: string; title: string; summary: string };
type State =
  | { phase: "idle" }
  | { phase: "loading"; query: string }
  | { phase: "done"; query: string; hits: Hit[]; ms: number }
  | { phase: "error"; query: string; message: string };

const SUGGESTIONS = ["agent", "durable", "slack", "defineAction", "cold start"];

const hrefOf = (slug: string) => (slug === "index" ? "/" : `/${slug}`);

async function searchSite(query: string): Promise<Hit[]> {
  const res = await fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_site", arguments: { query } },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (body.error) throw new Error(body.error.message);
  const text = body.result?.content?.find((c) => c.type === "text")?.text ?? "[]";
  if (body.result?.isError) throw new Error(text);
  return JSON.parse(text) as Hit[];
}

function AskPanel({ autoFocus }: { autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<State>({ phase: "idle" });
  const input = useRef<HTMLInputElement>(null);
  // Searches can finish out of order: only the latest one may write state, so a slow
  // earlier response never replaces the newer query's loading state or results.
  const latest = useRef(0);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const run = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const id = ++latest.current;
    setQ(trimmed);
    setState({ phase: "loading", query: trimmed });
    const t0 = performance.now();
    try {
      const hits = await searchSite(trimmed);
      if (id !== latest.current) return;
      setState({ phase: "done", query: trimmed, hits, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (id !== latest.current) return;
      setState({ phase: "error", query: trimmed, message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="j-ask">
      <form
        className="j-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <span className="pr">›</span>
        <input
          ref={input}
          className="j-ask-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask this site — it answers over its own /mcp"
          aria-label="Search june.build"
        />
        <span className="j-kbd">↵</span>
      </form>
      <div className="j-ask-body" aria-live="polite">
        {state.phase === "idle" && (
          <>
            <div className="j-ask-hint">
              This box is an MCP client. It calls <span style={{ color: "var(--s-tool)" }}>search_site</span> — a{" "}
              <code>defineAction()</code> on this site — exactly as an external agent would.
            </div>
            <div className="j-ask-sugg">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void run(s)}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {state.phase !== "idle" && (
          <div className="j-ask-rpc">
            POST /mcp · <span className="m">tools/call</span> search_site {JSON.stringify({ query: state.query })}
            {"\n"}
            {state.phase === "loading" && (
              <>
                … <span className="j-cursor" />
              </>
            )}
            {state.phase === "done" && (
              <span style={{ color: "var(--s-signal)" }}>
                ← {state.hits.length} result{state.hits.length === 1 ? "" : "s"} · {state.ms}ms
              </span>
            )}
            {state.phase === "error" && <span style={{ color: "var(--s-bad)" }}>← error: {state.message}</span>}
          </div>
        )}
        {state.phase === "done" && state.hits.length > 0 && (
          <div className="j-ask-hits">
            {state.hits.map((h) => (
              <a key={h.slug} className="j-ask-hit" href={hrefOf(h.slug)}>
                <small>{hrefOf(h.slug)}</small>
                <b>{h.title}</b>
                {h.summary && <span>{h.summary}</span>}
              </a>
            ))}
          </div>
        )}
        {state.phase === "done" && state.hits.length === 0 && (
          <div className="j-ask-hint" style={{ marginTop: 10 }}>
            Nothing matched. Try a single keyword — or read <a href="/llms.txt">/llms.txt</a>.
          </div>
        )}
      </div>
      <div className="j-ask-foot">
        <span>
          same tool at <a href="/mcp">/mcp</a>
        </span>
        <span>
          map at <a href="/llms.txt">/llms.txt</a>
        </span>
      </div>
    </div>
  );
}

export function AskSite({ variant = "dialog" }: { variant?: "dialog" | "inline" }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (variant !== "dialog") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  if (variant === "inline") {
    return (
      <div className="j-ask-inline">
        <AskPanel />
      </div>
    );
  }

  return (
    <>
      <button type="button" className="j-askbtn" onClick={() => setOpen(true)} aria-label="Ask this site">
        <span aria-hidden="true">›</span>
        <span className="lbl">Ask this site</span>
        <span className="j-kbd">⌘K</span>
      </button>
      <dialog
        ref={dialog}
        className="j-dialog"
        aria-label="Ask this site"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false); // backdrop click
        }}
      >
        {open && <AskPanel autoFocus />}
      </dialog>
    </>
  );
}
