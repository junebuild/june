import { POSTS } from "../_content";

export const prerender = true;

export default function Blog() {
  return (
    <>
      <header className="j-pagehead">
        <div className="j-pagehead-in">
          <p className="j-eyebrow">
            <span className="j-num">—</span> Notes from building June
          </p>
          <h1>Blog</h1>
          <p className="j-lead">Rendered for humans, verbatim markdown for agents — append <code>.md</code> to any post.</p>
        </div>
      </header>
      <div className="j-bloglist">
        {POSTS.map((p) => (
          <a
            key={p.slug}
            href={`/blog/${p.slug}`}
            className="j-post"
            lang={typeof p.data.lang === "string" ? p.data.lang : undefined}
          >
            <div className="j-post-meta">
              <span>{String(p.data.date)}</span>
            </div>
            <h3>{String(p.data.title)}</h3>
            <p>{String(p.data.description ?? "")}</p>
          </a>
        ))}
      </div>
    </>
  );
}

export const metadata = {
  title: "Blog",
  description: "Notes from building June — rendered for humans, verbatim markdown for agents.",
};
export const json = () => ({ posts: POSTS.map((p) => ({ slug: p.slug, ...p.data })) });
export const md = () =>
  "# Blog\n\n" + POSTS.map((p) => `- [${p.data.title}](/blog/${p.slug}) — ${p.data.date}`).join("\n") + "\n";
