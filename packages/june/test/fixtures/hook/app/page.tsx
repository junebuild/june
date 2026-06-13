import { useLoaderData, type Loaded } from "@junejs/core/route";

export const loader = () => ({ greeting: "hook-and-props" });

// A DEEP child reads loader data via the escape-hatch hook (no prop drilling).
function Deep() {
  const data = useLoaderData<typeof loader>();
  return <span data-deep>{data.greeting}</span>;
}

// The top-level view receives data as PROPS (canonical) — and a descendant uses
// the hook. Both surface the same value from one loader.
export default function Page({ greeting }: Loaded<typeof loader>) {
  return (
    <main>
      <h1 data-props>{greeting}</h1>
      <Deep />
    </main>
  );
}
