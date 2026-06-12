export default function NotFound({ pathname }: { pathname: string }) {
  return (
    <main data-boundary="not-found">
      <h1>Not found</h1>
      <p>
        Nothing lives at <code>{pathname}</code>. Try <a href="/docs">/docs</a> or{" "}
        <a href="/blog">/blog</a>.
      </p>
    </main>
  );
}
