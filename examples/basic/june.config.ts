import { defineJune } from "@junejs/core/config";

export default defineJune({
  site: {
    name: "June Basic",
    titleTemplate: "%s · June Basic",
    description: "The Phase 2 fixture app — the golden dev/built parity contract.",
  },
  // Agent surface on by default; spelled out here for the fixture's clarity.
  agent: { enabled: true, discovery: true, mcp: true, webmcp: true },
  viewTransitions: true,
});
