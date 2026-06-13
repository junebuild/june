import type { Loaded } from "@junejs/core/route";

// Prerendered at build: renders through the worker to a static index.html the
// assets layer serves at 0ms (rebuild-plan Phase 3).
export const prerender = true;

export const loader = () => ({ greeting: "Hello from June" });

export default function Home({ greeting }: Loaded<typeof loader>) {
  return (
    <main>
      <h1>June</h1>
      <p>{greeting}</p>
      <p>
        <a href="/users">Users</a> · <a href="/posts/hello">A post</a>
      </p>
    </main>
  );
}

// .json auto-derives from the loader data ({ greeting }); no export needed.
// Title === site name → the document shell must NOT template it into
// "June Basic · June Basic" (document.ts homepage rule).
export const metadata = { title: "June Basic" };
