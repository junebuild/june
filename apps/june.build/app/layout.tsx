// Root layout — wraps every route. The font stack ends in CJK faces (PingFang,
// Jhenghei, Noto Sans TC/JP) so the Chinese posts typeset natively, no webfont.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-layout="root"
      style={{
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", ' +
          '"PingFang TC", "Microsoft JhengHei", "Noto Sans TC", "Noto Sans JP", sans-serif',
        lineHeight: 1.6,
        maxWidth: 920,
        margin: "0 auto",
        padding: "0 16px",
      }}
    >
      <nav style={{ display: "flex", gap: 18, padding: "14px 6px", borderBottom: "1px solid #e4e2da", alignItems: "baseline" }}>
        <a href="/" style={{ fontWeight: 700, fontSize: 18 }}>June</a>
        <a href="/why">Why June</a>
        <a href="/docs">Docs</a>
        <a href="/blog">Blog</a>
        <a href="/benchmarks">Benchmarks</a>
        <span style={{ marginLeft: "auto", color: "#999", fontSize: 13 }}>
          agents: <a href="/llms.txt">llms.txt</a> · <code>/mcp</code>
        </span>
      </nav>
      {children}
      <footer style={{ padding: "32px 6px", color: "#888", fontSize: 13, borderTop: "1px solid #e4e2da", marginTop: 48 }}>
        Built with June, on June. Every page here is also markdown (append <code>.md</code>) — this site is its own dual-audience demo.
      </footer>
    </div>
  );
}
