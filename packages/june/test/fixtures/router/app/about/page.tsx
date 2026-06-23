import { Counter } from "../Counter";
export default function About() {
  return (
    <main>
      <h1 data-page="about">About</h1>
      <Counter initial={100} client:load />
    </main>
  );
}
export const metadata = { title: "About" };
