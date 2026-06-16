import { JuneOutlet } from "@junejs/core/outlet";

// The PERSISTENT SHELL: a sidebar that lives in the shared outer layout. The
// `segmentBoundary` export marks this layout as the boundary — soft-nav fragments
// render only what's INSIDE <JuneOutlet> (the content), so the sidebar is never
// re-rendered, re-sent, or morphed.
export const segmentBoundary = true;

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-shell>
      <nav data-sidebar>
        <a href="/">Home</a>
        <a href="/guide">Guide</a>
      </nav>
      <JuneOutlet>{children}</JuneOutlet>
    </div>
  );
}
