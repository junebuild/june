// The root layout wraps every route.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav className="border-b border-gray-200 px-6 py-3 text-sm">
        <a href="/" className="font-semibold">__APP_NAME__</a>
        <span className="text-gray-400"> · </span>
        <a href="/users" className="text-gray-600 hover:text-gray-900">Users</a>
      </nav>
      {children}
    </>
  );
}
