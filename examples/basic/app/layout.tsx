// Root layout — wraps every route. The build freezes this into the worker's
// layoutChains; the dev server loads it from this file. Both wrap identically,
// so the parity test sees the same <nav> in dev and built output.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav data-june-nav>
        <a href="/">June Basic</a>
      </nav>
      {children}
    </>
  );
}
