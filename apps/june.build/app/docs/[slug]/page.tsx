import { route } from "@junejs/core/route";

import { doc } from "../../_content";

export default route({
  metadata: ({ d }) => ({
    title: String(d.data.title ?? d.slug),
    description: String(d.data.description ?? ""),
    openGraph: { image: `https://june.build/og/${d.slug}.png` },
  }),
  async load(ctx) {
    const d = doc(ctx.params.slug);
    if (!d) throw new Error(`No doc "${ctx.params.slug}"`);
    return { d };
  },
  view: ({ d }) => (
    <main>
      <h1>{String(d.data.title)}</h1>
      <div dangerouslySetInnerHTML={{ __html: d.html }} />
    </main>
  ),
  md: ({ d }) => d.original,
  json: ({ d }) => ({ slug: d.slug, ...d.data, body: d.body }),
});
