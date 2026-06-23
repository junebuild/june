import { Live } from "./Live";
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav data-june-nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/users">Users</a>
      </nav>
      <Live client:load persist />
      {children}
    </>
  );
}
