// Optional-segment fixture: /notes (param absent) and /notes/swift (param set)
// both land here — parity.test.ts asserts dev ≡ built worker on both shapes.
import { route } from "@junejs/core/route";

export default route({
  load: (ctx) => ({ tag: ctx.params.tag ?? null }),
  view: ({ tag }) => <main data-page="notes">{tag ? `notes tagged ${tag}` : "all notes"}</main>,
  json: (d) => d,
  metadata: ({ tag }) => ({ title: tag ? `Notes: ${tag}` : "Notes" }),
});
