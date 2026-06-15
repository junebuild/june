// Docs segment layout: wraps every route under /docs with the design-system
// sidebar, NESTED inside the root layout — the build freezes this chain into the
// worker manifest. Active-link highlighting needs the path (layouts don't get
// it), so the sidebar stays plain links; View Transitions cover the nav polish.
import { docSections } from "./_sections";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-layout="docs" className="j-docs">
      <aside className="j-docs-side">
        <h4>
          <a href="/docs" style={{ color: "var(--s-text)", textDecoration: "none", fontWeight: 600 }}>
            Documentation
          </a>
        </h4>
        {docSections().map((section) => (
          <div key={section.title}>
            {section.title && <h4>{section.title}</h4>}
            {section.docs.map((d) => (
              <a key={d.slug} href={`/docs/${d.slug}`}>
                {String(d.data.nav ?? d.data.title)}
              </a>
            ))}
          </div>
        ))}
      </aside>
      <div className="j-docs-main">{children}</div>
    </div>
  );
}
