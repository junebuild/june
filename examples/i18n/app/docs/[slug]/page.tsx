import type { RouteContext, Loaded } from "@junejs/core/route";
// Frozen content (generated from content/docs/**). The finder takes the locale —
// it returns the <locale>/ variant when present, else falls back to the flat
// (default-locale) file. `ctx.locale` comes from the URL (/de/docs/intro → "de").
import { doc } from "../../_content";

export const loader = (ctx: RouteContext<{ slug: string }>) => ({
  entry: ctx.params.slug ? doc(ctx.params.slug, ctx.locale) : null,
  locale: ctx.locale,
});

export default function Doc({ entry, locale }: Loaded<typeof loader>) {
  return entry ? (
    <main>
      <p>
        locale: {locale} · source: {entry.locale ?? "default"}
      </p>
      <article dangerouslySetInnerHTML={{ __html: entry.html }} />
    </main>
  ) : (
    <main>
      <h1>Doc not found</h1>
    </main>
  );
}

// The .md projection is the authored source for the resolved locale, verbatim.
export const md = ({ entry }: Loaded<typeof loader>) => entry?.original ?? "# Not found\n";

export const metadata = ({ entry }: Loaded<typeof loader>) => ({
  title: (entry?.data.title as string) ?? "Doc",
});
