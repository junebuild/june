
import { bySlug } from "./content";
import { HeroViewer } from "./HeroViewer";
import { InstallCmd } from "./InstallCmd";
// Side-effect import: registers search_site / get_page so warmup surfaces them
// at /mcp (warmup loads route files; standalone modules must be reachable).
import "./actions";

const page = bySlug("index")!;

export const prerender = true;

const cw = { fontFamily: "var(--font-mono)", fontSize: "0.86em", color: "var(--s-strong)" } as const;

const SURFACES = [
  { mime: "text/html", h: "Human view", p: "Server-streamed RSC, zero client JS by default.", live: false },
  { mime: "text/markdown", h: "Agent reads", p: "The same route(), as clean markdown — append .md to any page.", live: false },
  { mime: "application/json", h: "Machine API", p: "The same route() as structured data.", live: false },
  { mime: "/mcp", h: "Agent acts", p: "Every defineAction() is a callable tool, one auth gate.", live: true },
];

const BENCH = [
  { v: "59", u: "ms", c: "dev cold start" },
  { v: "73", u: "ms", c: "HMR flight" },
  { v: "0", u: "", c: "client JS default" },
  { v: "8.8", u: "×", c: "fewer D1 queries" },
];

function Hero() {
  return (
    <header className="j-hero">
      <div className="j-hero-grid" />
      <div className="j-hero-in">
        <div className="j-hero-rail">
          <div className="j-hero-eyebrow">
            <span className="j-dot" />One definition · four surfaces
          </div>
          <h1>
            One <span className="j-codeword">route()</span> is <span className="j-accent">four surfaces.</span>
          </h1>
          <p className="j-hero-sub">
            June is the opinionated, agent-ready React framework. A single <code>route()</code> serves a page to
            people and <code>.md</code>, <code>.json</code>, and <code>/mcp</code> to agents — from one definition.
            Nothing drifts, because nothing is duplicated.
          </p>
          <div className="j-install">
            <InstallCmd />
            <a className="j-secondary-link" href="/why">
              Why June →
            </a>
          </div>
          <div className="j-hero-meta">
            <span>
              <b>59ms</b> dev cold start
            </span>
            <span>
              <b>0</b> client JS by default
            </span>
            <span>
              <b>1</b> auth gate, both audiences
            </span>
          </div>
        </div>
        <HeroViewer />
      </div>
    </header>
  );
}

function FourSurfaces() {
  return (
    <section className="j-section">
      <div className="j-section-in">
        <div className="j-section-head">
          <p className="j-eyebrow">
            <span className="j-num">01</span> — One definition
          </p>
          <h2 className="j-h2">Write it once. Serve humans and agents alike.</h2>
          <p className="j-lead">
            Every <code style={cw}>route()</code> projects four surfaces, and every{" "}
            <code style={cw}>defineAction()</code> is a UI action and an MCP tool. The projections are derived —
            never maintained by hand.
          </p>
        </div>
        <div className="j-surfaces">
          {SURFACES.map((s) => (
            <div key={s.mime} className={"j-surface" + (s.live ? " is-live" : "")}>
              <div className="j-surface-k">
                {s.live && <span className="j-livedot2" />}
                {s.mime}
              </div>
              <h3 className="j-surface-h">{s.h}</h3>
              <p className="j-surface-p">{s.p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function NoGlue() {
  return (
    <section className="j-section">
      <div className="j-section-in">
        <div className="j-split">
          <div className="j-split-text">
            <p className="j-eyebrow">
              <span className="j-num">02</span> — No glue layer
            </p>
            <h2 className="j-h2">Auth, data, and agents are one model.</h2>
            <p className="j-lead">
              There is no "expose to agents" step and no second permission system. A{" "}
              <code style={cw}>defineAction()</code> is a server action and an MCP tool behind a single
              authorization gate — <code style={cw}>run(input, ctx)</code> is the only gate.
            </p>
            <ul className="j-feature-list">
              <li>
                <span className="j-fk">one gate</span>
                <span className="j-fb">
                  <b>run(input, ctx)</b> — the same ctx whether the caller is your React UI or an agent at /mcp.
                </span>
              </li>
              <li>
                <span className="j-fk">no adapter</span>
                <span className="j-fb">
                  you wire <b>no adapter matrix</b>. The route graph derives the API catalog, sitemap, and
                  llms.txt.
                </span>
              </li>
              <li>
                <span className="j-fk">auth</span>
                <span className="j-fb">
                  <b>Better Auth</b> is the blessed default <i>(a first-class integration is coming soon)</i> — or
                  bring your own. Either way the gate is the same.
                </span>
              </li>
            </ul>
          </div>
          <div className="j-panel">
            <div className="j-panel-bar">
              <span className="fn">app/actions.ts</span>
              <span className="lg">ts</span>
            </div>
            <pre>
              {"import { db } from "}
              <span className="tk-str">"@junejs/db"</span>
              {";  "}
              <span className="tk-mut">{"// ambient + scoped — never on ctx"}</span>
              {"\n\nexport const "}
              <span className="tk-key">createUser</span>
              {" = "}
              <span className="tk-key">defineAction</span>
              {"({\n  id: "}
              <span className="tk-str">"createUser"</span>
              {",\n  description: "}
              <span className="tk-str">"Create a user"</span>
              {",  "}
              <span className="tk-mut">{"// → an MCP tool"}</span>
              {"\n  input: { name: "}
              <span className="tk-str">"string"</span>
              {" },\n  run: (input, ctx) => {\n    "}
              <span className="tk-mut">{"// ctx is the principal (user/session) — UI or agent."}</span>
              {"\n    return db.users.insert(input);\n  },\n});"}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function ScopedAgents() {
  return (
    <section className="j-agentband">
      <div className="j-agentband-glow" />
      <div className="j-agentband-in">
        <div>
          <p className="j-eyebrow">
            <span className="j-num">03</span> — Agents as scoped users
          </p>
          <h2>Watch an agent use your app.</h2>
          <p>
            No SDK, no tool re-declaration. Your routes and actions are the surface — an agent connects as a
            scoped principal and works the same authorization the UI does.
          </p>
          <ul className="j-feature-list">
            <li>
              <span className="j-fk">/mcp</span>
              <span className="j-fb">every action, as a callable tool</span>
            </li>
            <li>
              <span className="j-fk">/llms.txt</span>
              <span className="j-fb">the site map an agent reads first</span>
            </li>
            <li>
              <span className="j-fk">*.md</span>
              <span className="j-fb">your authored bytes, verbatim</span>
            </li>
          </ul>
          <div style={{ marginTop: 22, marginBottom: 22 }}>
            <span className="j-badge-agent">
              <span className="d" />scoped as user_42
            </span>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <a className="j-btn-agent solid" href="/mcp">
              Point an agent at /mcp →
            </a>
            <a className="j-btn-agent ghost" href="/docs/features-mcp">
              Read the MCP docs
            </a>
          </div>
        </div>
        <div className="j-console">
          <div className="j-console-bar">
            <span className="j-pulse" />agent session · /mcp<span className="dim">scoped as user_42</span>
          </div>
          <div className="j-console-body">
            <div className="j-console-step">
              <span className="j-console-n">01</span>
              <div>
                <div className="j-console-line">
                  <span className="pr">› </span>tools/list
                </div>
                <div className="j-mcp-chips" style={{ marginBottom: 0 }}>
                  {["search_site", "get_page", "createUser"].map((t) => (
                    <span key={t} className="j-mcp-chip">
                      <span className="d" />
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="j-console-step">
              <span className="j-console-n">02</span>
              <div>
                <div className="j-console-line">
                  <span className="pr">› </span>tools/call search_site {"{"}
                  <span className="k">"q"</span>: <span className="s">"cold start"</span>
                  {"}"} <span className="note">auth ✓</span>
                </div>
                <div className="j-console-out">
                  3 hits · top: <span style={{ color: "var(--agent-cyan)" }}>"59ms: anatomy of a dev cold start"</span>
                </div>
              </div>
            </div>
            <div className="j-console-step">
              <span className="j-console-n">●</span>
              <div>
                <span style={{ color: "var(--agent-green)" }}>done</span>
                <span style={{ color: "var(--agent-text-muted)" }}> · 2 tool calls · 71ms · one auth gate</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DataMagic() {
  return (
    <section className="j-section">
      <div className="j-section-in">
        <div className="j-split is-rev">
          <div className="j-split-text">
            <p className="j-eyebrow">
              <span className="j-num">04</span> — Data
            </p>
            <h2 className="j-h2">Declare it once. The layer does the rest.</h2>
            <p className="j-lead">
              Declare <code style={cw}>db</code> / <code style={cw}>kv</code> / <code style={cw}>blob</code> in
              your config; reach them ambiently with <code style={cw}>import &#123; db &#125;</code> — scoped per
              request, plain SQL, no ORM ceremony. It maps to D1, Turso, or local SQLite per target — or bring
              your own.
            </p>
            <ul className="j-feature-list">
              <li>
                <span className="j-fk">ambient db</span>
                <span className="j-fb">
                  <b>import &#123; db &#125;</b>, scoped per request — <b>ctx is identity-only</b> (user/session),
                  never the database.
                </span>
              </li>
              <li>
                <span className="j-fk">plain SQL</span>
                <span className="j-fb">
                  the <b>SQL you read is the SQL that runs</b> — no DSL for a human or an agent to misread.
                </span>
              </li>
              <li>
                <span className="j-fk">writes</span>
                <span className="j-fb">
                  <b>auto-invalidate</b> the cache — no revalidatePath, no tags to remember.
                </span>
              </li>
              <li>
                <span className="j-fk">reads</span>
                <span className="j-fb">
                  <b>8.8× fewer</b> queries on D1 vs concurrent per-component reads, auto-batched.
                </span>
              </li>
            </ul>
          </div>
          <div className="j-panel">
            <div className="j-panel-bar">
              <span className="fn">app/page.tsx</span>
              <span className="lg">tsx</span>
            </div>
            <pre>
              {"async function "}
              <span className="tk-key">Page</span>
              {"() {\n  "}
              <span className="tk-mut">{"// N reads in N components → 1 batched query"}</span>
              {"\n  const user = await db.users.find(id);\n  const posts = await db.posts.byAuthor(id);\n  return <Profile user={user} posts={posts} />;\n}\n\n"}
              <span className="tk-mut">{"// a write anywhere auto-invalidates the reads"}</span>
              {"\nawait db.posts.insert({ ... });  "}
              <span className="tk-mut">{"// cache: stale ✓"}</span>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function GettingStarted() {
  const steps = [
    { n: "01", cmd: "npm create june@latest", d: "Scaffold an app — no adapter matrix to configure." },
    { n: "02", cmd: "june dev", d: "Boot in 59ms. Save → HMR pushes a flight in 73ms." },
    { n: "03", cmd: "june build", d: "Freeze the dev graph into a deployable bundle." },
    { n: "04", cmd: "june deploy", d: "Ship to Workers, Vercel, or Deno — same graph." },
  ];
  return (
    <section className="j-section">
      <div className="j-section-in">
        <div className="j-section-head">
          <p className="j-eyebrow">
            <span className="j-num">05</span> — Start
          </p>
          <h2 className="j-h2">Ship in an afternoon.</h2>
          <p className="j-lead">
            Four commands from empty directory to an app deployed at the edge — already speaking to humans and
            agents.
          </p>
        </div>
        <div className="j-steps">
          {steps.map((s) => (
            <div key={s.n} className="j-step">
              <div className="j-step-n">{s.n}</div>
              <div className="j-step-cmd">
                <span className="p">$ </span>
                {s.cmd}
              </div>
              <div className="j-step-d">{s.d}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BenchStrip() {
  return (
    <section className="j-section">
      <div className="j-section-in">
        <div className="j-section-head">
          <p className="j-eyebrow">
            <span className="j-num">06</span> — Measured, not marketing
          </p>
          <h2 className="j-h2">Every number traces to a named run.</h2>
        </div>
        <div className="j-figs">
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
        <div style={{ marginTop: 28 }}>
          <a className="j-secondary-link" href="/benchmarks">
            See all benchmarks →
          </a>
        </div>
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="j-cta-band">
      <div className="j-cta-in">
        <h2>Your app is the agent's API.</h2>
        <p>
          One React framework for both audiences. 0.0.x preview — APIs will change, and we'll tell you when.
        </p>
        <div className="j-status">
          <span>
            <b className="ok">Stable</b>routes · projections · actions · MCP
          </span>
          <span>
            <b className="warn">Changing</b>data layer · auth
          </span>
          <span>
            <b className="exp">Experimental</b>native runtime · live RSC
          </span>
        </div>
        <div style={{ marginTop: 14 }}>
          <a className="j-secondary-link" href="/docs/05-stability">
            Stability &amp; roadmap →
          </a>
        </div>
        <div className="j-install">
          <InstallCmd />
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <Hero />
      <FourSurfaces />
      <NoGlue />
      <ScopedAgents />
      <DataMagic />
      <GettingStarted />
      <BenchStrip />
      <CtaBand />
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
