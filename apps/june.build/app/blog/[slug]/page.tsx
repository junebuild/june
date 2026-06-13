import type { RouteContext, Loaded } from "@junejs/core/route";

import { post } from "../../_content";

export const loader = (ctx: RouteContext<{ slug: string }>) => {
  const entry = post(ctx.params.slug);
  if (!entry) throw new Error(`No post "${ctx.params.slug}"`);
  return { entry };
};

export default function Post({ entry }: Loaded<typeof loader>) {
  return (
    // CJK posts declare `lang` in frontmatter; the attribute makes the browser
    // pick the right Han glyphs (TC vs JP) from the layout's font stack.
    <article lang={typeof entry.data.lang === "string" ? entry.data.lang : undefined}>
      <h1>{String(entry.data.title)}</h1>
      <p><small>{String(entry.data.date)}</small></p>
      <div dangerouslySetInnerHTML={{ __html: entry.html }} />
      <p><a href="/blog">← all posts</a></p>
    </article>
  );
}

export const metadata = ({ entry }: Loaded<typeof loader>) => ({
  title: String(entry.data.title ?? entry.slug),
  description: String(entry.data.description ?? ""),
  // Absolute URL (the OG spec wants one), constant origin so prerender stays
  // origin-independent. The card renders live at /og/<slug>.png (app/_extra).
  openGraph: { type: "article", image: `https://june.build/og/${entry.slug}.png` },
});
// the agent-facing projection: the authored file, verbatim
export const md = ({ entry }: Loaded<typeof loader>) => entry.original;
export const json = ({ entry }: Loaded<typeof loader>) => ({ slug: entry.slug, ...entry.data, body: entry.body });
