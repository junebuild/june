// The island is imported as a NORMAL module here; the server-graph plugin rewrites
// Tabs.tsx into a client reference automatically. clientManifest is generated.
import { Tabs } from "./Tabs";
export { CLIENT_MANIFEST as clientManifest } from "./_rsc-server.gen";
export function App() {
  return (
    <main>
      <h1>RSC pipeline</h1>
      <Tabs>
        <section data-tab="Overview"><p>SERVER overview</p></section>
        <section data-tab="Details"><p>SERVER details</p></section>
      </Tabs>
    </main>
  );
}
