import { Island } from "@junejs/core/islands";

import { Counter } from "../Counter";

export default function About() {
  return (
    <main>
      <h1 data-page="about">About</h1>
      {/* initial: 100 — distinct from Home's island, so the test can prove this
          page hydrated fresh (not a carried-over Counter). */}
      <Island name="Counter" component={Counter} props={{ initial: 100 }} />
    </main>
  );
}

export const metadata = { title: "About" };
