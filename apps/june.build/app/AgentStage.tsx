"use client";
// The hero centerpiece: ONE agent/ directory, three surfaces. The left rail is
// the directory (the manifest); the right is a turn on the chosen surface —
// Slack (a tool parks the turn for a manager's approval), Crisp (a per-surface
// policy hides the refund tool and swaps in instructions.crisp.md), and /mcp (an
// external agent hits the same run(input, ctx) gate). Files light up as the turn
// touches them. Server-renders the finished Slack turn; hydration plays it.
// prefers-reduced-motion shows every step at once.
import { useEffect, useState, type ReactNode } from "react";

type SurfaceId = "slack" | "crisp" | "mcp";

const FILES = [
  { id: "dir", label: "agent/", dir: true, depth: 0 },
  { id: "agent", label: "agent.ts", depth: 1 },
  { id: "instr", label: "instructions.md", depth: 1 },
  { id: "instr-crisp", label: "instructions.crisp.md", depth: 1 },
  { id: "tools", label: "tools/", dir: true, depth: 1 },
  { id: "get_order", label: "get_order.ts", depth: 2 },
  { id: "refund_order", label: "refund_order.ts", depth: 2 },
  { id: "skills", label: "skills/refunds.md", depth: 1 },
  { id: "channels", label: "channels/", dir: true, depth: 1 },
  { id: "slack", label: "slack.ts", depth: 2 },
  { id: "crisp", label: "crisp.ts", depth: 2 },
] as const;
type FileId = (typeof FILES)[number]["id"];

type Step = { node: ReactNode; hot?: FileId[]; hold?: number };
type Surface = {
  id: SurfaceId;
  label: string;
  where: ReactNode;
  off?: FileId[];
  note: ReactNode;
  steps: Step[];
};

const Msg = ({ who, meta, agent, children }: { who: string; meta?: string; agent?: boolean; children: ReactNode }) => (
  <div className="j-msg">
    <div className={"j-av" + (agent ? " is-agent" : "")}>{agent ? "J" : who[0]}</div>
    <div>
      <div className="j-msg-who">
        {who}
        {meta && <small>{meta}</small>}
      </div>
      <div className="j-msg-text">{children}</div>
    </div>
  </div>
);

const Call = ({ tool, args, result }: { tool: string; args: string; result: ReactNode }) => (
  <div className="j-call">
    <span className="t">⚙ {tool}</span>
    <span className="a">{args}</span>
    <span className="r">{result}</span>
  </div>
);

const SURFACES: Surface[] = [
  {
    id: "slack",
    label: "Slack",
    where: (
      <>
        <b>#ops</b> · slackChannel · streamed
      </>
    ),
    note: (
      <>
        <b>ctx.requestInput</b> parked the turn in the session log. Nothing waits in memory — on Workers the Durable Object can hibernate until someone answers.
      </>
    ),
    steps: [
      {
        node: (
          <Msg who="Dana" meta="support">
            <span className="at">@ops</span> refund order <code>#4812</code> — arrived broken, photos in thread
          </Msg>
        ),
        hot: ["slack"],
      },
      { node: <Call tool="get_order" args='{ id: 4812 }' result="✓ $84.00 · delivered" />, hot: ["get_order", "instr"] },
      { node: <Call tool="read_skill" args='{ name: "refunds" }' result="✓" />, hot: ["skills"] },
      {
        node: (
          <div className="j-park">
            <div className="j-park-h">
              <span className="j-dot is-human" />
              refund_order · awaiting approval
            </div>
            <div className="j-park-p">Refund $84.00 to card •• 4242 for order #4812?</div>
            <div className="j-park-btns">
              <span className="is-yes">Approve</span>
              <span>Deny</span>
            </div>
          </div>
        ),
        hot: ["refund_order"],
        hold: 1500,
      },
      {
        node: (
          <div className="j-sys">
            <span>
              approved by <b>@maya</b> (manager)
            </span>
            <span className="sep">·</span>
            <span>turn resumed</span>
          </div>
        ),
        hot: ["refund_order"],
      },
      {
        node: (
          <Msg who="ops" meta="agent" agent>
            Refunded <b>$84.00</b> to •• 4242. I&apos;ve replied to the customer and noted it on the ticket.
          </Msg>
        ),
        hot: ["slack"],
      },
      {
        node: (
          <div className="j-sys">
            <b>● done</b>
            <span className="sep">·</span>3 tool calls<span className="sep">·</span>parked 41s
            <span className="sep">·</span>ctx.user = U04MAYA
          </div>
        ),
      },
    ],
  },
  {
    id: "crisp",
    label: "Crisp",
    where: (
      <>
        <b>customer chat</b> · crispChannel
      </>
    ),
    off: ["refund_order"],
    note: (
      <>
        <b>surfaces.crisp</b>: <code>denyTools: [&quot;refund_order&quot;]</code> — the model never sees it here, and a
        call would be refused anyway.
      </>
    ),
    steps: [
      {
        node: (
          <Msg who="Customer" meta="visitor">
            Hi — my order #4812 arrived broken. Can I get a refund?
          </Msg>
        ),
        hot: ["crisp"],
      },
      { node: <Call tool="get_order" args='{ id: 4812 }' result="✓ delivered" />, hot: ["get_order", "instr-crisp"] },
      {
        node: (
          <Msg who="ops" meta="agent" agent>
            I&apos;m sorry it arrived damaged. I&apos;ve passed it to our team with your photos — you&apos;ll hear back
            today about the refund.
          </Msg>
        ),
        hot: ["instr-crisp", "crisp"],
      },
      {
        node: (
          <div className="j-park">
            <div className="j-park-h">
              <span className="j-dot is-human" />
              private note · operators only
            </div>
            <div className="j-park-p">Order #4812 ($84.00) damaged in transit. Suggest full refund — needs a human.</div>
          </div>
        ),
        hot: ["crisp"],
      },
      {
        node: (
          <div className="j-sys">
            <b>● done</b>
            <span className="sep">·</span>instructions.crisp.md<span className="sep">·</span>refund_order hidden
          </div>
        ),
      },
    ],
  },
  {
    id: "mcp",
    label: "/mcp",
    where: (
      <>
        <b>POST /mcp</b> · an external agent, scoped as user_42
      </>
    ),
    note: (
      <>
        The same <b>tools/</b> are your app&apos;s MCP server. One gate — <code>run(input, ctx)</code> — for the UI,
        the agent, and anyone else&apos;s agent.
      </>
    ),
    steps: [
      {
        node: (
          <div className="j-rpc">
            <span className="pr">› </span>
            <span className="m">tools/list</span>
            <span className="o">get_order · refund_order · search_site · get_page</span>
          </div>
        ),
        hot: ["get_order", "refund_order"],
      },
      {
        node: (
          <div className="j-rpc">
            <span className="pr">› </span>
            <span className="m">tools/call</span> get_order {"{ "}
            <span className="k">&quot;id&quot;</span>: <span className="s">4812</span>
            {" }"}
            <span className="o">
              ✓ ctx.user = user_42 · {"{ status: \"delivered\", total: 84.00 }"}
            </span>
          </div>
        ),
        hot: ["get_order"],
      },
      {
        node: (
          <div className="j-rpc">
            <span className="pr">› </span>
            <span className="m">tools/call</span> refund_order {"{ "}
            <span className="k">&quot;id&quot;</span>: <span className="s">4812</span>
            {" }"}
            <span className="o" style={{ color: "var(--s-bad)" }}>
              ✕ forbidden — user_42 may not refund. Same check the UI runs.
            </span>
          </div>
        ),
        hot: ["refund_order"],
      },
      {
        node: (
          <div className="j-sys">
            <b>● done</b>
            <span className="sep">·</span>2 tool calls<span className="sep">·</span>one auth gate
          </div>
        ),
      },
    ],
  },
];

function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function AgentStage() {
  const [surfaceId, setSurfaceId] = useState<SurfaceId>("slack");
  const surface = SURFACES.find((s) => s.id === surfaceId)!;
  // server + first paint: the finished turn (useful without JS); hydration replays it
  const [step, setStep] = useState(surface.steps.length);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setStep(surface.steps.length);
      return;
    }
    let n = 1;
    setStep(n);
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const hold = surface.steps[n - 1]?.hold ?? 900;
      timer = setTimeout(() => {
        n += 1;
        setStep(n);
        if (n < surface.steps.length) tick();
      }, hold);
    };
    tick();
    return () => clearTimeout(timer);
  }, [surfaceId, run]);

  const shown = surface.steps.slice(0, step);
  const hot = new Set<FileId>(shown.at(-1)?.hot ?? []);
  const off = new Set<FileId>(surface.off ?? []);
  const live = step < surface.steps.length;

  return (
    <div className="j-stage">
      <aside className="j-stage-side" aria-label="The agent directory">
        <div className="j-stage-h">the manifest</div>
        <ul className="j-tree">
          {FILES.map((f) => (
            <li
              key={f.id}
              className={
                ("dir" in f ? "is-dir " : "") +
                (f.depth ? `d${f.depth} ` : "") +
                (hot.has(f.id) ? "is-hot " : "") +
                (off.has(f.id) ? "is-off" : "")
              }
            >
              <span className="ic">{"dir" in f ? "▾" : "·"}</span>
              {f.label}
            </li>
          ))}
        </ul>
        <div className="j-stage-note">{surface.note}</div>
      </aside>
      <div className="j-stage-main">
        <div className="j-stage-bar">
          <div className="j-stage-where">
            <span className={"j-dot" + (live ? "" : " is-idle")} />
            {surface.where}
          </div>
          <div className="j-seg" role="group" aria-label="Surface">
            {SURFACES.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={s.id === surfaceId}
                className={s.id === surfaceId ? "is-on" : ""}
                onClick={() => {
                  setSurfaceId(s.id);
                  setRun((r) => r + 1);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="j-stage-body" role="log" aria-live="off">
          {shown.map((s, i) => (
            <div key={`${surfaceId}-${run}-${i}`}>{s.node}</div>
          ))}
          {!live && (
            <button type="button" className="j-stage-replay" onClick={() => setRun((r) => r + 1)}>
              ↻ replay
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
