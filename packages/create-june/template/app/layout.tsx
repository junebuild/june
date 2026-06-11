// The root layout wraps every route.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav>
        <a href="/">__APP_NAME__</a> · <a href="/users">Users</a>
      </nav>
      {children}
    </>
  );
}
