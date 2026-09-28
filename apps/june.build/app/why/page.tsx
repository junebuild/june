// /why — authored ONCE, as content/pages/why.md. The view renders that file's html
// (headings linkable, like the docs); the .md projection serves its source bytes,
// and search_site / get_page read the same entry via content.ts. A hand-written JSX
// copy used to sit here and had already drifted from the markdown.
import { page as entryOf } from "../_content";
import { bySlug } from "../content";
import { withAnchorLinks } from "../headings";
import { ogImage } from "../og-card";
import { scrollableTables } from "../tables";

const page = bySlug("why")!;
const entry = entryOf("why")!;

export const prerender = true;

export default function Why() {
  return (
    <>
      <header className="j-pagehead">
        <div className="j-pagehead-in">
          <p className="j-eyebrow">
            <span className="j-num">—</span> The thesis
          </p>
          <h1>{page.title}</h1>
          <p className="j-lead">{page.summary}</p>
        </div>
      </header>
      <div className="j-post-read">
        <div className="j-doc-body" dangerouslySetInnerHTML={{ __html: scrollableTables(withAnchorLinks(entry.html)) }} />
      </div>
    </>
  );
}

export const metadata = {
  title: page.title, // from the file's frontmatter, like the H1 — one source for the page's name
  description: page.summary,
  openGraph: ogImage("why"),
};
export const md = () => page.md;
export const json = () => ({ title: page.title, summary: page.summary, headings: entry.headings });
