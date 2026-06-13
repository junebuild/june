// Optional-segment fixture: /notes (param absent) and /notes/swift (param set)
// both land here — parity.test.ts asserts dev ≡ built worker on both shapes.
import type { RouteContext, Loaded } from "@junejs/core/route";

export const loader = (ctx: RouteContext<{ tag?: string }>) => ({ tag: ctx.params.tag ?? null });

export default function Notes({ tag }: Loaded<typeof loader>) {
  return <main data-page="notes">{tag ? `notes tagged ${tag}` : "all notes"}</main>;
}

export const metadata = ({ tag }: Loaded<typeof loader>) => ({ title: tag ? `Notes: ${tag}` : "Notes" });
