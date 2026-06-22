// The RSC root (opt-in). The server-graph plugin turns Tabs into a client
// reference; clientManifest is the generated render manifest.
import { Tabs } from "./Tabs";
export { CLIENT_MANIFEST as clientManifest } from "./_rsc-server.gen";
export function App() {
  return (
    <main>
      <h1>RSC app root</h1>
      <Tabs>
        <section data-tab="Overview"><p>SERVER overview</p></section>
      </Tabs>
    </main>
  );
}
