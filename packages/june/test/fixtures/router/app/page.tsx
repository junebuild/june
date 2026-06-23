import { Counter } from "./Counter";

export default function Home() {
  return (
    <main>
      <h1 data-page="home">Home</h1>
      <Counter initial={0} />
    </main>
  );
}

export const metadata = { title: "Home" };
