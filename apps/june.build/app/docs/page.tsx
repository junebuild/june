import { route } from "@junejs/core/route";

import { docSections } from "./_sections";

export default route({
  prerender: true,
  metadata: {
    title: "Docs",
    description: "June documentation — every page is also markdown (append .md).",
  },
  load: () => ({ sections: docSections() }),
  view: ({ sections }) => (
    <main>
      <h1>Documentation</h1>
      {sections.map((section) => (
        <section key={section.title}>
          {section.title && <h2>{section.title}</h2>}
          <ul style={{ lineHeight: 2 }}>
            {section.docs.map((d) => (
              <li key={d.slug}>
                <a href={`/docs/${d.slug}`}>{String(d.data.title)}</a> — {String(d.data.description ?? "")}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p style={{ color: "#888", fontSize: 14 }}>
        Agents: every doc serves its authored markdown at <code>/docs/&lt;slug&gt;.md</code>.
      </p>
    </main>
  ),
  json: ({ sections }) => ({
    docs: sections.flatMap((s) =>
      s.docs.map((d) => ({ slug: d.slug, ...d.data })),
    ),
  }),
  md: ({ sections }) =>
    "# June docs\n\n" +
    sections
      .map(
        (s) =>
          (s.title ? `## ${s.title}\n\n` : "") +
          s.docs.map((d) => `- [${d.data.title}](/docs/${d.slug}) — ${d.data.description}`).join("\n"),
      )
      .join("\n\n") +
    "\n",
});
