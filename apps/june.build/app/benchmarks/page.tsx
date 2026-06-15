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

export const prerender = true;

export default function Benchmarks() {
  return (
    <>
      <header className="j-pagehead">
        <div className="j-pagehead-in">
          <p className="j-eyebrow">
            <span className="j-num">—</span> Measured, not marketing
          </p>
          <h1>Benchmarks</h1>
          <p className="j-lead">
            {RESULTS.machine}. Every number traces to a named script + date (
            <a href="https://github.com/junebuild/june">repo</a>) — re-run it, don&apos;t trust it.
            Runtime-section numbers come from the experimental native runtime track, not the v0.1
            default host.
          </p>
        </div>
      </header>
      <div className="j-post-read">
        {sections.map((s) => (
          <section key={s.title}>
            <div className="j-bench-group">{s.title}</div>
            <table className="j-bench-table">
              <thead>
                <tr>
                  {["metric", "value", "context", "run"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.metric}>
                    <td>{r.metric}</td>
                    <td className="v">{r.value}</td>
                    <td>{r.context}</td>
                    <td className="m">
                      <code>{r.script}</code> · {r.measured}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </>
  );
}

export const metadata = {
  title: "Benchmarks",
  description: page.summary,
  openGraph: { image: "https://june.build/og/benchmarks.png" },
};
export const md = () => page.md;
export const json = () => ({
  title: page.title,
  machine: RESULTS.machine,
  sections: sections.map((s) => ({ title: s.title, metrics: s.rows })),
});
