import { Tabs } from "./Tabs";
export default function Page() {
  return (
    <main>
      <h1>RSC app root</h1>
      <Tabs>
        <section data-tab="Overview"><p>SERVER overview</p></section>
      </Tabs>
    </main>
  );
}
