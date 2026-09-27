import type { RouteContext, Loaded } from "@junejs/core/route";

import { doc } from "../../_content";
import { withAnchorLinks } from "../../headings";
import { ogImage } from "../../og-card";
import { scrollableTables } from "../../tables";

export const loader = (ctx: RouteContext<{ slug: string }>) => {
  const d = doc(ctx.params.slug);
  if (!d) throw new Error(`No doc "${ctx.params.slug}"`);
  return { d };
};

export default function Doc({ d }: Loaded<typeof loader>) {
  // "On this page": the framework's entry.headings — the same ids the rendered headings carry
  const toc = d.headings.filter((h) => h.depth === 2 || h.depth === 3);
  return (
    <div className="j-doc-layout">
      <article className="j-doc-body">
        <h1>{String(d.data.title)}</h1>
        {d.data.description && <p className="j-lead" style={{ marginBottom: 24 }}>{String(d.data.description)}</p>}
        <div dangerouslySetInnerHTML={{ __html: scrollableTables(withAnchorLinks(d.html)) }} />
      </article>
      {toc.length > 1 && (
        <nav className="j-toc" aria-label="On this page">
          <p className="j-toc-h">On this page</p>
          <ul>
            {toc.map((h) => (
              <li key={h.id} className={h.depth === 3 ? "is-sub" : undefined}>
                <a href={`#${h.id}`}>{h.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

export const metadata = ({ d }: Loaded<typeof loader>) => ({
  title: String(d.data.title ?? d.slug),
  description: String(d.data.description ?? ""),
  openGraph: ogImage(d.slug),
});
export const md = ({ d }: Loaded<typeof loader>) => d.original;
// agents get the section structure too: each heading's id is a deep link into the page
export const json = ({ d }: Loaded<typeof loader>) => ({ slug: d.slug, ...d.data, headings: d.headings, body: d.body });
