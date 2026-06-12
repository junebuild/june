import { route } from "@junejs/core/route";

import { DOCS } from "../_content";

const ordered = [...DOCS].sort((a, b) => a.slug.localeCompare(b.slug));

export default route({
  prerender: true,
  metadata: {
    title: "Docs",
    description: "June documentation — every page is also markdown (append .md).",
  },
  load: () => ({ docs: ordered }),
  view: ({ docs }) => (
    <main>
      <h1>Documentation</h1>
      <ul style={{ lineHeight: 2 }}>
        {docs.map((d) => (
          <li key={d.slug}>
            <a href={`/docs/${d.slug}`}>{String(d.data.title)}</a> — {String(d.data.description ?? "")}
          </li>
        ))}
      </ul>
      <p style={{ color: "#888", fontSize: 14 }}>
        Agents: every doc serves its authored markdown at <code>/docs/&lt;slug&gt;.md</code>.
      </p>
    </main>
  ),
  json: ({ docs }) => ({ docs: docs.map((d) => ({ slug: d.slug, ...d.data })) }),
  md: ({ docs }) =>
    "# June docs\n\n" + docs.map((d) => `- [${d.data.title}](/docs/${d.slug}) — ${d.data.description}`).join("\n") + "\n",
});
