// A page: the default export is the view (it receives the loader's data as
// props); named exports configure the other surfaces. No loader → static.
import type { Loaded } from "@junejs/core/route";
import { Island } from "@junejs/core/islands";

import { Counter } from "./Counter";

export const loader = () => ({ message: "Welcome to June" });

export default function Home({ message }: Loaded<typeof loader>) {
  return (
    <main>
      <h1>__APP_NAME__</h1>
      <p>{message}</p>
      <p>
        This page also answers as <a href="/.json">JSON</a> and <a href="/.md">Markdown</a>,
        and exposes its actions to agents at <code>/mcp</code>.
      </p>
      {/* A client island: only this subtree hydrates (app/_client.tsx registers it). */}
      <Island name="Counter" component={Counter} props={{ initial: 0 }} />
    </main>
  );
}

// .json auto-derives from the loader data; no export needed.
export const metadata = { title: "__APP_NAME__" };
