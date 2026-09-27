import type { Loaded } from "@junejs/core/route";

import { docSections } from "./_sections";

export const prerender = true;

export const loader = () => ({ sections: docSections() });

export default function Docs({ sections }: Loaded<typeof loader>) {
  return (
    <article className="j-doc-body j-doc-index">
      <h1>Documentation</h1>
      <p className="j-lead">
        Every page here is also markdown — append <code>.md</code>, or ask this site from the ⌘K box.
      </p>
      {sections.map((section) => (
        <section key={section.title}>
          {section.title && <h2>{section.title}</h2>}
          <ul>
            {section.docs.map((d) => (
              <li key={d.slug}>
                <a href={`/docs/${d.slug}`}>
                  <b>{String(d.data.title)}</b>
                  {d.data.description && <span>{String(d.data.description)}</span>}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

export const metadata = {
  title: "Docs",
  description: "June documentation — every page is also markdown (append .md).",
};
export const json = ({ sections }: Loaded<typeof loader>) => ({
  docs: sections.flatMap((s) => s.docs.map((d) => ({ slug: d.slug, ...d.data }))),
});
export const md = ({ sections }: Loaded<typeof loader>) =>
  "# June docs\n\n" +
  sections
    .map(
      (s) =>
        (s.title ? `## ${s.title}\n\n` : "") +
        s.docs.map((d) => `- [${d.data.title}](/docs/${d.slug}) — ${d.data.description}`).join("\n"),
    )
    .join("\n\n") +
  "\n";
