import { Live } from "./Live";

// Root layout. The persistent island lives HERE, inside the swapped region, so its
// survival across navigation is entirely the router's doing.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav data-june-nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/users">Users</a>
      </nav>
      <Live />
      {children}
    </>
  );
}
