import type { RouteContext, Loaded } from "@junejs/core/route";

import { doc } from "../../_content";

export const loader = (ctx: RouteContext<{ slug: string }>) => {
  const d = doc(ctx.params.slug);
  if (!d) throw new Error(`No doc "${ctx.params.slug}"`);
  return { d };
};

export default function Doc({ d }: Loaded<typeof loader>) {
  return (
    <main>
      <h1>{String(d.data.title)}</h1>
      <div dangerouslySetInnerHTML={{ __html: d.html }} />
    </main>
  );
}

export const metadata = ({ d }: Loaded<typeof loader>) => ({
  title: String(d.data.title ?? d.slug),
  description: String(d.data.description ?? ""),
  openGraph: { image: `https://june.build/og/${d.slug}.png` },
});
export const md = ({ d }: Loaded<typeof loader>) => d.original;
export const json = ({ d }: Loaded<typeof loader>) => ({ slug: d.slug, ...d.data, body: d.body });
