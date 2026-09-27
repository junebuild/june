import { AgentStage } from "./AgentStage";
import { AskSite } from "./AskSite";
import { bySlug } from "./content";
import { InstallCmd } from "./InstallCmd";
// Side-effect import: registers search_site / get_page so warmup surfaces them
// at /mcp (warmup loads route files; standalone modules must be reachable).
import "./actions";

const page = bySlug("index")!;

export const prerender = true;

const BENCH = [
  { v: "59", u: "ms", c: "dev cold start" },
  { v: "73", u: "ms", c: "HMR flight" },
  { v: "0", u: "", c: "client JS by default" },
  { v: "8.8", u: "×", c: "fewer D1 queries" },
];

function Head({ n, label, title, lead }: { n: string; label: string; title: React.ReactNode; lead: React.ReactNode }) {
  return (
    <div className="j-section-head">
      <div>
        <p className="j-eyebrow">
          <span className="j-num">{n}</span> {label}
        </p>
        <h2 className="j-h2">{title}</h2>
      </div>
      <p className="j-lead">{lead}</p>
    </div>
  );
}

function Hero() {
  return (
    <header className="j-hero">
      <div className="j-hero-grid" />
      <div className="j-hero-in">
        <div className="j-hero-copy">
          <a className="j-hero-tag" href="#agents">
            <span className="j-dot" />
            <b>New</b> the agent layer — channels, connections, durable turns →
          </a>
          <h1>
            Build agents
            <br />
            <span className="dim">into real apps.</span>
          </h1>
          <p className="j-hero-sub">
            June is the React framework where an agent is a feature, not a separate runtime. Drop an{" "}
            <code>agent/</code> directory into your app: its tools are your server actions, its channels are Slack,
            Crisp, or HTTP, and every turn is durable — checkpointed, resumable, one Durable Object per session at the edge.
          </p>
          <div className="j-hero-cta">
            <InstallCmd client:load />
            <a className="j-btn" href="/docs/01-getting-started">
              Get started
            </a>
            <a className="j-link" href="/why">
              Why June →
            </a>
          </div>
        </div>
        <div className="j-hero-stage">
          <AgentStage client:load />
        </div>
      </div>
    </header>
  );
}

const MANIFEST = [
  {
    f: "agent.ts",
    d: (
      <>
        <b>Name, model, per-surface policy.</b> A plain object — <code>surfaces.slack.denyTools</code> hides a tool
        from one channel.
      </>
    ),
  },
  {
    f: "instructions.md",
    d: (
      <>
        <b>The system prompt</b>, as a file you can diff. <code>instructions.&lt;source&gt;.md</code> appends to it —
        or replaces it — on one surface.
      </>
    ),
  },
  {
    f: "tools/*.ts",
    d: (
      <>
        <b>Each file is a <code>defineAction()</code></b> — the same one your UI calls and <code>/mcp</code> serves.
        A raw tool when it needs the turn itself, e.g. to ask a human.
      </>
    ),
  },
  {
    f: "skills/*.md",
    d: (
      <>
        <b>Loaded on demand</b> through an automatic <code>read_skill</code> tool — long procedures stay out of
        the prompt until needed.
      </>
    ),
  },
  {
    f: "channels/*.ts",
    d: (
      <>
        <b>Inbound edges.</b> <code>slackChannel</code>, <code>crispChannel</code>, <code>httpChannel</code>, or
        your own <code>defineChannel</code>.
      </>
    ),
  },
  {
    f: "connections/*.ts",
    d: (
      <>
        <b>Outbound tool sources.</b> A remote MCP server, an OpenAPI spec, Google Drive — credentials resolved
        server-side per call.
      </>
    ),
  },
];

function Manifest() {
  return (
    <section className="j-section" id="agents">
      <div className="j-section-in">
        <Head
          n="01"
          label="The agent layer"
          title="The directory is the manifest."
          lead={
            <>
              No agent framework to adopt, no config to assemble. June discovers <code>agent/</code>, mounts it in
              dev, and compiles it for the edge on <code>june build</code>. Presence is the API.
            </>
          }
        />
        <div className="j-manifest">
          {MANIFEST.map((m) => (
            <div key={m.f} className="j-manifest-row">
              <div className="j-manifest-f">
                <span className="dir">agent/</span>
                {m.f}
              </div>
              <div className="j-manifest-arrow">→</div>
              <div className="j-manifest-d">{m.d}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 24, display: "flex", gap: 20, flexWrap: "wrap" }}>
          <a className="j-link" href="/docs/agents-overview">
            Agents overview →
          </a>
          <a className="j-link" href="/docs/agents-directory">
            The agent/ directory reference →
          </a>
        </div>
      </div>
    </section>
  );
}

function OneAction() {
  return (
    <section className="j-section">
      <div className="j-section-in">
        <div className="j-split">
          <div className="j-split-text">
            <p className="j-eyebrow">
              <span className="j-num">02</span> No glue layer
            </p>
            <h2 className="j-h2">One action. Four callers. One gate.</h2>
            <p className="j-lead">
              There is no &quot;expose to agents&quot; step and no second permission system. The{" "}
              <code>defineAction()</code> your button calls is the tool your agent calls — and the tool anyone
              else&apos;s agent calls at <code>/mcp</code>.
            </p>
            <div className="j-gate">
              <span className="j-dot" />
              <span>
                <b>run(input, ctx)</b> — ctx.user is whoever is really asking
              </span>
            </div>
            <div className="j-callers">
              {[
                ["your UI", "A server action behind a button or form."],
                ["your agent", "A tool in agent/tools/, scoped to the speaker a channel resolved."],
                ["/mcp", "An MCP tool for any external agent holding a user's credential."],
                ["WebMCP", "A browser tool, registered with navigator.modelContext."],
              ].map(([k, p]) => (
                <div key={k} className="j-caller">
                  <div className="j-caller-k">{k}</div>
                  <p className="j-caller-p">{p}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="j-panel">
            <div className="j-panel-bar">
              <span className="fn">agent/tools/refund_order.ts</span>
              <span className="lg">ts</span>
            </div>
            <pre>
              {"import { "}
              <span className="tk-fn">defineAction</span>
              {" } from "}
              <span className="tk-str">&quot;@junejs/core/agent&quot;</span>
              {";\nimport { db } from "}
              <span className="tk-str">&quot;@junejs/db&quot;</span>
              {";\n\nexport default "}
              <span className="tk-fn">defineAction</span>
              {"({\n  id: "}
              <span className="tk-str">&quot;refund_order&quot;</span>
              {",\n  description: "}
              <span className="tk-str">&quot;Refund a delivered order.&quot;</span>
              {",\n  input: { "}
              <span className="tk-key">type</span>
              {": "}
              <span className="tk-str">&quot;object&quot;</span>
              {", "}
              <span className="tk-key">properties</span>
              {": { id: { type: "}
              <span className="tk-str">&quot;number&quot;</span>
              {" } } },\n  requiresPrincipal: "}
              <span className="tk-key">true</span>
              {",  "}
              <span className="tk-mut">{"// hidden from anonymous turns"}</span>
              {"\n  "}
              <span className="tk-key">async</span>
              {" run(input, ctx) {\n    "}
              <span className="tk-mut">{"// the one gate: a button, the agent, and /mcp all land here"}</span>
              {"\n    "}
              <span className="tk-key">if</span>
              {" (!ctx.user?.canRefund) "}
              <span className="tk-key">throw</span>
              {" "}
              <span className="tk-key">new</span>
              {" Error("}
              <span className="tk-str">&quot;forbidden&quot;</span>
              {");\n    "}
              <span className="tk-key">return</span>
              {" db.orders.refund(input.id);\n  },\n});"}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function Hub() {
  return (
    <section className="j-section">
      <div className="j-section-in">
        <Head
          n="03"
          label="Channels & connections"
          title="Meet people where they work. Reach what they use."
          lead={
            <>
              Channels bring turns in and resolve who is speaking. Connections take tools out — the agent never holds
              a token. Each is one file.
            </>
          }
        />
        <div className="j-hub">
          <div className="j-hub-col">
            <h3 className="j-hub-h">
              <span className="j-pill is-signal">in</span> channels/
            </h3>
            {[
              ["slackChannel", "Streams its reply, shows a thinking line, approval buttons, drops redeliveries."],
              ["crispChannel", "Customer chat — plus private notes only your operators see."],
              ["httpChannel", "POST /message for your own UI, a CLI, or a cron."],
              ["defineChannel", "Anything else with a webhook."],
            ].map(([n, d]) => (
              <div key={n} className="j-hub-item">
                <span className="n">{n}</span>
                <span className="d">{d}</span>
              </div>
            ))}
            <a className="j-link" href="/docs/agents-channels">
              Channels →
            </a>
          </div>
          <div className="j-hub-col j-hub-core">
            <div className="j-hub-core-box">
              <div className="t">
                <span className="j-dot" />
                agent/
              </div>
              <p>One agent, many surfaces. Each surface can append or replace the instructions and deny tools.</p>
            </div>
            <div className="j-hub-pills">
              <span className="j-pill is-tool">tools = your actions</span>
              <span className="j-pill is-human">ctx.user per speaker</span>
              <span className="j-pill">anthropic()</span>
            </div>
          </div>
          <div className="j-hub-col">
            <h3 className="j-hub-h">
              <span className="j-pill is-tool">out</span> connections/
            </h3>
            {[
              ["MCP server", "Any remote MCP server; its tools arrive as conn__tool."],
              ["OpenAPI", "Point at a spec — operations become tools."],
              ["Google Drive", "Read and save files, on the user's own linked account."],
              ["auth(ctx)", "Credentials resolve server-side per call, never in the prompt."],
            ].map(([n, d]) => (
              <div key={n} className="j-hub-item">
                <span className="n">{n}</span>
                <span className="d">{d}</span>
              </div>
            ))}
            <a className="j-link" href="/docs/agents-connections">
              Connections →
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Durable() {
  const turns = [
    {
      s: "running",
      c: "var(--s-signal)",
      h: "Crash-proof",
      p: (
        <>
          Every model call and tool result is checkpointed. Redeliver a turn after a crash and it replays: finished steps are skipped, not re-run.
        </>
      ),
    },
    {
      s: "parked",
      c: "var(--s-human)",
      h: "Human in the loop",
      p: (
        <>
          A tool calls <code>ctx.requestInput()</code> and the turn parks for an answer — minutes or days — then
          picks back up. Slack renders it as Approve / Deny.
        </>
      ),
    },
    {
      s: "replaced",
      c: "var(--s-tool)",
      h: "Superseded cleanly",
      p: <>Opt in to replace, and a newer message cancels the unfinished turn instead of queueing behind it.</>,
    },
    {
      s: "initiated",
      c: "var(--s-signal)",
      h: "Agent goes first",
      p: <>An agent can start a turn itself — a reminder, a follow-up — through the same log and channels.</>,
    },
  ];
  return (
    <section className="j-section">
      <div className="j-section-in">
        <Head
          n="04"
          label="Durable turns"
          title="A turn is a process, not a request."
          lead={
            <>
              Real work outlives an HTTP request. June persists each turn as it runs and streams its events, so
              an agent can wait on a person, survive a restart, and still answer in the right thread.
            </>
          }
        />
        <div className="j-turns">
          {turns.map((t) => (
            <div key={t.s} className="j-turn">
              <div className="j-turn-state" style={{ color: t.c }}>
                <span className="j-dot" style={{ background: t.c, boxShadow: "none" }} />
                {t.s}
              </div>
              <h3>{t.h}</h3>
              <p>{t.p}</p>
            </div>
          ))}
        </div>
        <div className="j-runtimes">
          <div className="j-runtime">
            <span className="j-runtime-k">june dev</span>
            <div>
              <b>NativeRuntime · SQLite</b>
              <span>Mounted automatically when agent/ exists, on Bun or Node. SQLite in memory by default — fast to iterate, reset on restart.</span>
            </div>
          </div>
          <div className="j-runtime">
            <span className="j-runtime-k">deploy</span>
            <div>
              <b>Workers · one Durable Object per session</b>
              <span>june build generates the DO class and the wrangler binding. Nothing to wire.</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 24, display: "flex", gap: 20, flexWrap: "wrap" }}>
          <a className="j-link" href="/docs/agents-durable-turns">
            Durable turns →
          </a>
          <a className="j-link" href="/docs/agents-deploy">
            Run &amp; deploy →
          </a>
        </div>
      </div>
    </section>
  );
}

function AskBand() {
  return (
    <section className="j-section">
      <div className="j-section-in">
        <div className="j-split">
          <div className="j-split-text">
            <p className="j-eyebrow">
              <span className="j-num">05</span> Try it on this site
            </p>
            <h2 className="j-h2">This site is a June app. Ask it.</h2>
            <p className="j-lead">
              The box calls <code>search_site</code> on this site&apos;s own <code>/mcp</code> — a{" "}
              <code>defineAction()</code> in <code>app/actions.ts</code>, the same tool Claude or any agent gets. Or
              point one at it:
            </p>
            <div className="j-panel" style={{ marginTop: 24 }}>
              <pre>
                <span className="tk-fn">$</span>
                {" curl -X POST https://june.build/mcp \\\n    -d '"}
                <span className="tk-str">{'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'}</span>
                {"'"}
              </pre>
            </div>
          </div>
          <AskSite client:load variant="inline" />
        </div>
      </div>
    </section>
  );
}

function Foundation() {
  return (
    <section className="j-section">
      <div className="j-section-in">
        <Head
          n="06"
          label="The foundation"
          title="Underneath: a framework that already speaks agent."
          lead={
            <>
              The agent layer stands on the same core that serves your pages — server-first React where every
              route is readable by people and machines alike.
            </>
          }
        />
        <div className="j-bento">
          <div className="j-cell w4">
            <span className="j-cell-k">route()</span>
            <h3>One definition, four surfaces.</h3>
            <p>
              A page&apos;s default export is the view; named exports configure the rest. Nothing drifts, because
              nothing is duplicated — append <code>.md</code> to any URL on this site.
            </p>
            <div className="j-surf">
              <div>
                <b>text/html</b>
                <span>streamed RSC</span>
              </div>
              <div>
                <b>.md</b>
                <span>your authored bytes</span>
              </div>
              <div>
                <b>.json</b>
                <span>the loader data</span>
              </div>
              <div>
                <b>/mcp</b>
                <span>every action</span>
              </div>
            </div>
          </div>
          <div className="j-cell w2">
            <span className="j-cell-k">discovery</span>
            <h3>llms.txt, sitemap, API catalog.</h3>
            <p>Derived from the route graph. On by default — june.config.ts exists to turn things off.</p>
            <a className="j-link" href="/docs/features-llms-txt">
              llms.txt →
            </a>
          </div>
          <div className="j-cell w2">
            <span className="j-cell-k">data</span>
            <h3>Ambient db, plain SQL.</h3>
            <p>
              <code>import {"{ db }"}</code>, scoped per request. Writes auto-invalidate; reads auto-batch.
            </p>
            <a className="j-link" href="/docs/features-data">
              Data model →
            </a>
          </div>
          <div className="j-cell w2">
            <span className="j-cell-k">rsc + islands</span>
            <h3>Zero client JS by default.</h3>
            <p>Interactivity is an explicit island. Navigation is the browser&apos;s — Speculation Rules, View Transitions.</p>
            <a className="j-link" href="/docs/features-islands">
              Islands →
            </a>
          </div>
          <div className="j-cell w2">
            <span className="j-cell-k">web standards</span>
            <h3>fetch(Request) → Response.</h3>
            <p>That is the framework. Bun-first toolchain, runtime-agnostic core, deploys to Workers.</p>
            <a className="j-link" href="/docs/features-web-standards">
              Web Standards →
            </a>
          </div>
        </div>
        <div className="j-figs" style={{ marginTop: 64 }}>
          {BENCH.map((b) => (
            <div key={b.c} className="j-fig">
              <div className="j-fig-v">
                {b.v}
                <small>{b.u}</small>
              </div>
              <div className="j-fig-c">{b.c}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 24 }}>
          <a className="j-link" href="/benchmarks">
            Every number traces to a named run →
          </a>
        </div>
      </div>
    </section>
  );
}

function Status() {
  const cols = [
    { k: "ok", h: "Stable", items: ["routes & projections", "defineAction()", "/mcp, llms.txt, discovery"] },
    { k: "warn", h: "Changing", items: ["the agent layer (agent/, channels, connections)", "data layer", "auth"] },
    { k: "exp", h: "Experimental", items: ["native Rust+V8 runtime", "live RSC"] },
  ];
  return (
    <section className="j-section">
      <div className="j-section-in">
        <Head
          n="07"
          label="Honest status"
          title="0.0.x preview. APIs will change — we'll say which."
          lead={
            <>
              The shape is settled; the surface is still moving. Calibrate with the{" "}
              <a href="/docs/05-stability">stability &amp; roadmap</a> page.
            </>
          }
        />
        <div className="j-status">
          {cols.map((c) => (
            <div key={c.k} className="j-status-col">
              <div className={"j-status-h " + c.k}>
                <span className="j-dot" style={{ background: "currentColor", boxShadow: "none", animation: "none" }} />
                {c.h}
              </div>
              <ul>
                {c.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="j-cta">
      <div className="j-cta-in">
        <h2>Your app is the agent.</h2>
        <p>Start with a page. Add an agent/ directory when you need one. Deploy both with one command.</p>
        <div className="j-hero-cta" style={{ justifyContent: "center" }}>
          <InstallCmd client:load />
          <a className="j-btn" href="/docs">
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <Hero />
      <Manifest />
      <OneAction />
      <Hub />
      <Durable />
      <AskBand />
      <Foundation />
      <Status />
      <Cta />
    </>
  );
}

export const metadata = {
  title: page.title,
  description: page.summary,
  openGraph: { image: "https://june.build/og/index.png" },
};
export const md = () => page.md;
export const json = () => ({ title: page.title, summary: page.summary });
