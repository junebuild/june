// No db usage here — the build path under test is config-driven (the declared
// turso() db wires the resource provider), not a runtime query.
export const loader = () => ({ title: "Turso" });
export default function Home({ title }: { title: string }) {
  return (
    <main>
      <h1>{title}</h1>
    </main>
  );
}
