import { Island } from "@junejs/core/islands";

import { Live } from "./Live";

// Root layout. Note the persistent island lives HERE, inside the swapped region
// (June composes layouts into the route tree — there is no document-shell escape
// hatch), so its survival across navigation is entirely the router's doing.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav data-june-nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/users">Users</a>
      </nav>
      <Island name="Live" component={Live} persist />
      {children}
    </>
  );
}
