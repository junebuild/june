import { Tabs } from "./client-refs";
// Maps the client-reference id → its chunk descriptor (the client manifest).
export const clientManifest = { "rsc/Tabs": { id: "rsc/Tabs", chunks: [], name: "Tabs" } };
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
