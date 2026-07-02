import type { RouteContext } from "@junejs/core/route";

// A DYNAMIC catch-all. It cannot be enumerated by the router, so it ships to the
// static site only because it exports `staticPaths` — the concrete pathnames to
// prerender, locale prefixes already applied (the producer owns that; Kura does the
// same for the docs catch-all). Each path renders one <slug>/index.html.
export const staticPaths = (): string[] => [
  "/guide/getting-started",
  "/guide/advanced",
  "/de/guide/getting-started",
];

export const loader = (ctx: RouteContext) => ({
  slug: String((ctx.params as { slug?: string })?.slug ?? ""),
  locale: ctx.locale ?? "en",
});
export default function Guide({ slug, locale }: { slug: string; locale: string }) {
  return <main><h1>Guide: {slug}</h1><p data-locale={locale}>{locale}</p></main>;
}
export const md = ({ slug }: { slug: string }) => `# Guide: ${slug}`;
export const json = ({ slug, locale }: { slug: string; locale: string }) => ({ slug, locale });
