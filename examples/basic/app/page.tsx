import { route } from "junecore/route";

export default route({
  // Prerendered at build: renders through the worker to a static index.html the
  // assets layer serves at 0ms (rebuild-plan Phase 3).
  prerender: true,
  load: () => ({ greeting: "Hello from June" }),
  view: (data) => (
    <main>
      <h1>June</h1>
      <p>{data.greeting}</p>
      <p>
        <a href="/users">Users</a> · <a href="/posts/hello">A post</a>
      </p>
    </main>
  ),
  json: (data) => data,
  // Title === site name → the document shell must NOT template it into
  // "June Basic · June Basic" (document.ts homepage rule, reminder-adjacent).
  metadata: { title: "June Basic" },
});
