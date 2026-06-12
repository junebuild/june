import { route } from "@junejs/core/route";

import { post } from "../../_content";

export default route({
  metadata: ({ entry }) => ({
    title: String(entry.data.title ?? entry.slug),
    description: String(entry.data.description ?? ""),
    openGraph: { type: "article" },
  }),
  async load(ctx) {
    const entry = post(ctx.params.slug);
    if (!entry) throw new Error(`No post "${ctx.params.slug}"`);
    return { entry };
  },
  view: ({ entry }) => (
    // CJK posts declare `lang` in frontmatter; the attribute makes the browser
    // pick the right Han glyphs (TC vs JP) from the layout's font stack.
    <article lang={typeof entry.data.lang === "string" ? entry.data.lang : undefined}>
      <h1>{String(entry.data.title)}</h1>
      <p><small>{String(entry.data.date)}</small></p>
      <div dangerouslySetInnerHTML={{ __html: entry.html }} />
      <p><a href="/blog">← all posts</a></p>
    </article>
  ),
  // the agent-facing projection: the authored file, verbatim
  md: ({ entry }) => entry.original,
  json: ({ entry }) => ({ slug: entry.slug, ...entry.data, body: entry.body }),
});
