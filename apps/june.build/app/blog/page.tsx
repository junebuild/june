import { POSTS } from "../_content";

export const prerender = true;

export default function Blog() {
  return (
    <main>
      <h1>Blog</h1>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {POSTS.map((p) => (
          <li key={p.slug} style={{ marginBottom: 18 }} lang={typeof p.data.lang === "string" ? p.data.lang : undefined}>
            <a href={`/blog/${p.slug}`} style={{ fontSize: 18 }}>{String(p.data.title)}</a>
            <br />
            <small style={{ color: "#777" }}>{String(p.data.date)} — {String(p.data.description ?? "")}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}

export const metadata = {
  title: "Blog",
  description: "Notes from building June — rendered for humans, verbatim markdown for agents.",
};
export const json = () => ({ posts: POSTS.map((p) => ({ slug: p.slug, ...p.data })) });
export const md = () =>
  "# Blog\n\n" + POSTS.map((p) => `- [${p.data.title}](/blog/${p.slug}) — ${p.data.date}`).join("\n") + "\n";
