import { defineAction } from "@junejs/core/agent";

// A tool the app defines — a static host can't run it, so the static build must
// not advertise it (no /mcp, no WebMCP) anywhere it publishes.
export const lookup = defineAction({
  id: "lookup",
  description: "Look something up.",
  input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  run: ({ q }) => ({ q }),
});
