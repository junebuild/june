import { route } from "@junejs/core/route";
import { Island } from "@junejs/core/islands";

import { Counter } from "./Counter";

export default route({
  load: () => ({ message: "Welcome to June" }),
  view: (data) => (
    <main>
      <h1>__APP_NAME__</h1>
      <p>{data.message}</p>
      <p>
        This page also answers as <a href="/.json">JSON</a> and <a href="/.md">Markdown</a>,
        and to agents at <a href="/.agent">.agent</a> and <code>/mcp</code>.
      </p>
      {/* A client island: only this subtree hydrates (app/_client.tsx registers it). */}
      <Island name="Counter" component={Counter} props={{ initial: 0 }} />
    </main>
  ),
  json: (data) => data,
  metadata: { title: "__APP_NAME__" },
});
