import type { Loaded } from "@junejs/core/route";

// loading.tsx is present, BUT metadata is a FUNCTION of the loaded data — the
// <title> needs the data, so this route must NOT stream (the head can't flush
// before load resolves). The pipeline gates it back to buffered.
export const loader = async (): Promise<{ title: string }> => {
  await new Promise((r) => setTimeout(r, 20));
  return { title: "Derived Title" };
};

export default function SlowMeta({ title }: Loaded<typeof loader>) {
  return <main data-page="slow-meta">{title}</main>;
}

export const metadata = ({ title }: Loaded<typeof loader>) => ({ title });
