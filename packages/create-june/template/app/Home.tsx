// The page's view — a server component, kept out of the route so the JSX is
// easy to read and maintain. The route() hands it the loaded data.
import { Island } from "@junejs/core/islands";

import { Counter } from "./Counter";

export function Home({ message }: { message: string }) {
  return (
    <main>
      <h1>__APP_NAME__</h1>
      <p>{message}</p>
      <p>
        This page also answers as <a href="/.json">JSON</a> and <a href="/.md">Markdown</a>,
        and to agents at <a href="/.agent">.agent</a> and <code>/mcp</code>.
      </p>
      {/* A client island: only this subtree hydrates (app/_client.tsx registers it). */}
      <Island name="Counter" component={Counter} props={{ initial: 0 }} />
    </main>
  );
}
