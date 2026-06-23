// Root layout — wraps every route. The June Design System chrome: a sticky nav
// (wordmark + global "view as" + theme switch), the page, and the footer. The
// styling lives in app/global.css (auto-linked); the body font stack ends in CJK
// faces so the Chinese posts typeset natively, no webfont.

import { ThemeToggle } from "./ThemeToggle";
import { ViewAs } from "./ViewAs";

// Applies the saved theme to <html> BEFORE paint (no flash for dark users). No
// stored choice → no attribute → the stylesheet's warm-light default. Inline and
// synchronous; the ThemeToggle island only handles later flips.
const THEME_INIT =
  "(function(){try{var t=localStorage.getItem('june-theme');" +
  "if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();";

const NAV = [
  { href: "/why", label: "Why June" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/benchmarks", label: "Benchmarks" },
];

const FOOTER_COLS = [
  {
    h: "Product",
    links: [["Why June", "/why"], ["Docs", "/docs"], ["Benchmarks", "/benchmarks"], ["Blog", "/blog"]],
  },
  {
    h: "For agents",
    links: [["/llms.txt", "/llms.txt"], ["/mcp", "/mcp"], ["sitemap.xml", "/sitemap.xml"], ["Every page .md", "/index.md"]],
  },
  {
    h: "Project",
    links: [
      ["GitHub", "https://github.com/junebuild/june"],
      ["npm @junejs", "https://www.npmjs.com/org/junejs"],
      ["0.0.x preview", "/why"],
    ],
  },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="j-app" data-ready="1" data-layout="root">
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />

      <nav className="j-nav">
        <div className="j-nav-in">
          <a className="j-wm" href="/" aria-label="June home">
            June<sup>0.0.x</sup>
          </a>
          <div className="j-nav-links">
            {NAV.map((n) => (
              <a key={n.href} className="j-navlink" href={n.href}>
                {n.label}
              </a>
            ))}
          </div>
          <div className="j-nav-right">
            <ViewAs client:load />
            <ThemeToggle client:load />
          </div>
        </div>
      </nav>

      <main className="j-main">{children}</main>

      <footer className="j-footer">
        <div className="j-footer-in">
          <div className="j-footer-brand">
            <a className="j-wm" href="/">
              June
            </a>
            <p className="j-footer-tag">
              The agent-ready React framework. One definition serves humans and agents — HTML, markdown,
              JSON, MCP.
            </p>
          </div>
          {FOOTER_COLS.map((c) => (
            <div key={c.h} className="j-footer-col">
              <h4>{c.h}</h4>
              {c.links.map(([label, href]) => (
                <a key={label} href={href}>
                  {label}
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="j-footer-bar">
          <div className="j-footer-bar-in">
            <span>June — 0.0.x preview · built with June, on June</span>
            <span>
              Every page is also <a href="/index.md">/&lt;page&gt;.md</a> · <a href="/llms.txt">/llms.txt</a> ·{" "}
              <a href="/mcp">/mcp</a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
