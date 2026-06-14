import { Island } from "@junejs/core/islands";

import { Counter } from "./Counter";

export default function Home() {
  return (
    <main>
      <h1 data-page="home">Home</h1>
      <Island name="Counter" component={Counter} props={{ initial: 0 }} />
    </main>
  );
}

export const metadata = { title: "Home" };
