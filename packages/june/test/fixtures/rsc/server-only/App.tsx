// A pure server component (no client island) — proves the server graph + SSR
// graph work end-to-end with zero client references.
export const clientManifest = {};
export function App() {
  return (
    <main>
      <h1>Server only</h1>
      <p>pure server content</p>
    </main>
  );
}
