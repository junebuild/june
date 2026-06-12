// Docs segment layout: wraps every route under /docs with a sidebar, NESTED
// inside the root layout — the build freezes this chain into the worker manifest.
import { DOCS } from "../_content";

const ordered = [...DOCS].sort((a, b) => a.slug.localeCompare(b.slug));

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-layout="docs" style={{ display: "flex", gap: 32 }}>
      <nav style={{ minWidth: 180, padding: "32px 0", borderRight: "1px solid #e4e2da" }}>
        <p style={{ fontWeight: 700, marginTop: 0 }}>
          <a href="/docs">Docs</a>
        </p>
        <ul style={{ listStyle: "none", padding: 0, lineHeight: 2 }}>
          {ordered.map((d) => (
            <li key={d.slug}>
              <a href={`/docs/${d.slug}`} style={{ fontSize: 14 }}>{String(d.data.title)}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
