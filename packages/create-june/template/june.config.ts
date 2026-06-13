import { defineJune } from "@junejs/core/config";

export default defineJune({
  site: {
    name: "__APP_NAME__",
    titleTemplate: "%s · __APP_NAME__",
    description: "A June app — agent-ready by default.",
  },
  // The agent surface (llms.txt, /mcp, .md/.json projections) is on by default.
  agent: { enabled: true },
});
