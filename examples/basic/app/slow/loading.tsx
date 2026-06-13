// Streaming Suspense fallback: flushed in the shell while the loader is pending.
export default function Loading() {
  return <main data-loading="slow">Loading…</main>;
}
