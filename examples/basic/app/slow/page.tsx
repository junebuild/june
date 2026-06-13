import type { Loaded } from "@junejs/core/route";

// A deliberately-slow loader: the shell + loading.tsx flush first, then this
// streams in. Demonstrates streaming Suspense (gated by the sibling loading.tsx).
export const loader = async (): Promise<{ value: string }> => {
  await new Promise((r) => setTimeout(r, 40));
  return { value: "streamed in after the shell" };
};

export default function Slow({ value }: Loaded<typeof loader>) {
  return <main data-page="slow">{value}</main>;
}

export const metadata = { title: "Slow" };
