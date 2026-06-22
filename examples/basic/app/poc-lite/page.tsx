import { Counter } from "../poc/Counter";

// Per-page isolation proof: this route uses ONLY <Counter>. With code-splitting
// it must download client.js + the shared React chunk + Counter.js — and must
// NOT download Tabs.js (that chunk belongs to /poc, which renders <Tabs>).
export default function PocLitePage() {
  return (
    <main>
      <h1>PoC · split isolation</h1>
      <p>This page renders only a Counter. Watch the Network panel: no Tabs.js.</p>
      <Counter initial={0} label="lite" />
    </main>
  );
}

export const metadata = { title: "PoC split isolation" };
