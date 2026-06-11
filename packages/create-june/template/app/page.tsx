import { route } from "junecore/route";

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
    </main>
  ),
  json: (data) => data,
  metadata: { title: "__APP_NAME__" },
});
