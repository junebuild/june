// The view for a page authored as content/pages/<slug>.md (/about, /contact, /privacy):
// the file's html with linkable headings under a page header. The route module keeps
// its own metadata/md/json exports, built by contentRoute() from the same entry.
import { page as entryOf } from "./_content";
import { bySlug } from "./content";
import { withAnchorLinks } from "./headings";
import { ogImage } from "./og-card";
import { scrollableTables } from "./tables";

export function contentRoute(slug: string, eyebrow: string) {
  const page = bySlug(slug)!;
  const entry = entryOf(slug)!;
  function View() {
    return (
      <>
        <header className="j-pagehead">
          <div className="j-pagehead-in">
            <p className="j-eyebrow">
              <span className="j-num">—</span> {eyebrow}
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
  return {
    View,
    metadata: { title: page.title, description: page.summary, openGraph: ogImage(slug) },
    md: () => page.md,
    json: () => ({ title: page.title, summary: page.summary, headings: entry.headings }),
  };
}
