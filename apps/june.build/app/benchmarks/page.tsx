import { route } from "@junejs/core/route";

import { bySlug } from "../content";
// THE named-run registry: numbers live in bench/results.json next to the
// scripts that produce them; this page (and the .md/.json projections via
// content.ts) renders from it. Never hand-edit a number here.
import RESULTS from "../../../../bench/results.json";

const page = bySlug("benchmarks")!;
const sections = RESULTS.sections as Array<{
  title: string;
  rows: Array<{ metric: string; value: string; context: string; script: string; measured: string }>;
}>;

export default route({
  prerender: true,
  metadata: { title: "Benchmarks", description: page.summary },
  view: () => (
    <main>
      <h1>Benchmarks</h1>
      <p style={{ color: "#666" }}>
        {RESULTS.machine}. Every number traces to a named script + date (
        <a href="https://github.com/junebuild/june">repo</a>) — re-run it, don&apos;t trust it.
        Runtime-section numbers come from the experimental native runtime track, not the v0.1
        default host.
      </p>
      {sections.map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["metric", "value", "context", "run"].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: "2px solid #ddd", padding: 8 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <tr key={r.metric}>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.metric}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}><strong>{r.value}</strong></td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee", color: "#666" }}>{r.context}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee", color: "#999", fontSize: 13 }}>
                    <code>{r.script}</code> · {r.measured}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  ),
  md: () => page.md,
  json: () => ({
    title: page.title,
    machine: RESULTS.machine,
    sections: sections.map((s) => ({ title: s.title, metrics: s.rows })),
  }),
});
