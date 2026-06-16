import type { RouteContext, Loaded } from "@junejs/core/route";
import { localeHref } from "@junejs/server";

import config from "../june.config";

const i18n = config.i18n!;

// The loader has ctx, so it builds the locale switcher with localeHref — the SAME
// table that resolved the request drives the outbound links (cross-origin locales
// come back absolute).
export const loader = (ctx: RouteContext) => ({
  locale: ctx.locale,
  links: Object.keys(i18n.locales).map((loc) => ({
    loc,
    href: localeHref(i18n, "/docs/intro", loc, { currentHost: ctx.url.host }),
  })),
});

export default function Home({ locale, links }: Loaded<typeof loader>) {
  return (
    <main>
      <h1>June i18n example</h1>
      <p>Resolved locale: {locale}</p>
      <nav>
        <p>Read the intro doc in:</p>
        <ul>
          {links.map((l) => (
            <li key={l.loc}>
              <a href={l.href}>{l.loc}</a>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
