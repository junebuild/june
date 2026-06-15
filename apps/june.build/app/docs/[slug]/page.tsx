import type { RouteContext, Loaded } from "@junejs/core/route";

import { doc } from "../../_content";

export const loader = (ctx: RouteContext<{ slug: string }>) => {
  const d = doc(ctx.params.slug);
  if (!d) throw new Error(`No doc "${ctx.params.slug}"`);
  return { d };
};

export default function Doc({ d }: Loaded<typeof loader>) {
  return (
    <article className="j-doc-body">
      <h1>{String(d.data.title)}</h1>
      {d.data.description && <p className="j-lead" style={{ marginBottom: 24 }}>{String(d.data.description)}</p>}
      <div dangerouslySetInnerHTML={{ __html: d.html }} />
    </article>
  );
}

export const metadata = ({ d }: Loaded<typeof loader>) => ({
  title: String(d.data.title ?? d.slug),
  description: String(d.data.description ?? ""),
  openGraph: { image: `https://june.build/og/${d.slug}.png` },
});
export const md = ({ d }: Loaded<typeof loader>) => d.original;
export const json = ({ d }: Loaded<typeof loader>) => ({ slug: d.slug, ...d.data, body: d.body });
